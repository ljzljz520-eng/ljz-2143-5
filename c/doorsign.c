/* doorsign.c — 会议室门牌显示端（C99）
 *
 * 设计要点：
 *  - 纯 POSIX socket HTTP（无第三方依赖）；轮询 /api/displays/<room>/state
 *  - 状态层与背景层解耦：背景拉取失败只在底部提示，绝不遮挡当前占用状态
 *  - 本地缓存最近一次成功状态；断网仍可渲染（online_only 房间“只查看缓存”，
 *    offline_allowed 房间可排队离线签到）
 *  - 设备时钟漂移：每次心跳上报 deviceMs，服务器回 serverMs 校准 offset
 *  - 断线跨会议边界：恢复后以服务器状态为准重绘，本地不自己翻场/倒计时裁决
 *  - 乱序防护：按 HTTP 轮询的最新响应整体替换，不做增量；SSE 序号去重在服务端/网页
 *
 * 用法：
 *   doorsign --server 127.0.0.1:8080 --room 1 [--token tok-bob]
 *            [--mode render|checkin|queue|probe|simskew] [--meeting 3]
 *            [--cache /tmp/sign.json] [--shift-ms 3600000] [--once]
 */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <time.h>
#include <errno.h>
#include <sys/socket.h>
#include <netdb.h>

#define MAX_BODY (1<<20)
#define MAX_QUEUE 64

typedef struct { char *base; size_t len, cap; } buf_t;

static void buf_need(buf_t *b, size_t n){
  if (b->cap >= b->len+n+1) return;
  size_t c = b->cap ? b->cap*2 : 4096;
  while (c < b->len+n+1) c*=2;
  b->base = realloc(b->base, c); b->cap = c;
}
static void buf_append(buf_t *b, const char *p, size_t n){ buf_need(b,n); memcpy(b->base+b->len,p,n); b->len+=n; b->base[b->len]=0; }

/* ---------------- 最小 JSON 解析（只支持本服务返回的对象树） ---------------- */
typedef struct JVal JVal;
typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } JType;
struct JVal {
  JType t;
  double num; char *str;                 /* J_STR/J_BOOL(0/1) */
  JVal **items; size_t n;                /* J_ARR */
  char **keys; JVal **vals; size_t m;    /* J_OBJ */
};

static const char *j_skip(const char *s){ while(*s && (unsigned char)*s<=32) s++; return s; }
static JVal *j_parse(const char **sp);

static char *j_decode_str(const char *s, const char *e){
  buf_t b={0};
  for(const char*p=s;p<e;p++){
    if(*p=='\\' && p+1<e){
      p++; char c=*p;
      if(c=='n') c='\n'; else if(c=='t') c='\t'; else if(c=='r') c='\r';
      char z[1]={c}; buf_append(&b,z,1);
    } else { char z[1]={*p}; buf_append(&b,z,1); }
  }
  return b.base ? b.base : strdup("");
}
static JVal *j_new(JType t){ JVal*v=calloc(1,sizeof*v); v->t=t; return v; }

static JVal *j_parse_str(const char **sp){
  const char *s=*sp+1;
  while(*s && *s!='"'){ if(*s=='\\') s++; s++; }
  JVal *v=j_new(J_STR); v->str=j_decode_str(*sp+1,s);
  *sp = *s ? s+1 : s; return v;
}
static JVal *j_parse_num(const char **sp){
  char *e; double d=strtod(*sp,&e); *sp=e; JVal*v=j_new(J_NUM); v->num=d; return v;
}
static JVal *j_parse_arr(const char **sp){
  JVal *v=j_new(J_ARR); (*sp)++;
  *sp=j_skip(*sp);
  if(**sp==']'){ (*sp)++; return v; }
  for(;;){
    JVal *x=j_parse(sp);
    if(v->n%8==0) v->items=realloc(v->items,(v->n+8)*sizeof(void*));
    v->items[v->n++]=x;
    *sp=j_skip(*sp);
    if(**sp==','){ (*sp)++; *sp=j_skip(*sp); continue; }
    if(**sp==']'){ (*sp)++; break; }
    if(!**sp) break;
  }
  return v;
}
static JVal *j_parse_obj(const char **sp){
  JVal *v=j_new(J_OBJ); (*sp)++;
  *sp=j_skip(*sp);
  if(**sp=='}'){ (*sp)++; return v; }
  for(;;){
    *sp=j_skip(*sp);
    JVal *k=j_parse_str(sp);
    *sp=j_skip(*sp); if(**sp==':') (*sp)++;
    *sp=j_skip(*sp);
    JVal *val=j_parse(sp);
    if(v->m%8==0){ v->keys=realloc(v->keys,(v->m+8)*sizeof(void*));
      v->vals=realloc(v->vals,(v->m+8)*sizeof(void*)); }
    v->keys[v->m]=k->str; v->vals[v->m]=val; v->m++;
    *sp=j_skip(*sp);
    if(**sp==','){ (*sp)++; continue; }
    if(**sp=='}'){ (*sp)++; break; }
    if(!**sp) break;
  }
  return v;
}
static JVal *j_parse(const char **sp){
  *sp=j_skip(*sp);
  if(**sp=='"') return j_parse_str(sp);
  if(**sp=='{') return j_parse_obj(sp);
  if(**sp=='[') return j_parse_arr(sp);
  if(!strncmp(*sp,"true",4)){ *sp+=4; JVal*v=j_new(J_BOOL); v->num=1; return v; }
  if(!strncmp(*sp,"false",5)){ *sp+=5; return j_new(J_BOOL); }
  if(!strncmp(*sp,"null",4)){ *sp+=4; return j_new(J_NULL); }
  return j_parse_num(sp);
}
static JVal *j_get(const JVal *o, const char *k){
  if(!o||o->t!=J_OBJ) return NULL;
  for(size_t i=0;i<o->m;i++) if(!strcmp(o->keys[i],k)) return o->vals[i];
  return NULL;
}
static const char *j_str(const JVal *o,const char*k){ JVal*v=j_get(o,k); return v&&v->t==J_STR?v->str:NULL; }
static double j_numd(const JVal *o,const char*k){ JVal*v=j_get(o,k); return v&&(v->t==J_NUM||v->t==J_BOOL)?v->num:0; }
static int j_isnull(JVal*v){ return !v||v->t==J_NULL; }
static long long j_ms(const JVal*o,const char*k){ return (long long)j_numd(o,k); }

/* ---------------- HTTP GET（chunked/Content-Length 都支持） ---------------- */
typedef struct { int status; char *body; size_t len; } http_resp;

static int tcp_connect(const char *host, const char *port){
  struct addrinfo hints={0},*res=NULL,*rp; int fd=-1;
  hints.ai_socktype=SOCK_STREAM;
  if(getaddrinfo(host,port,&hints,&res)) return -1;
  for(rp=res;rp;rp=rp->ai_next){
    fd=socket(rp->ai_family,rp->ai_socktype,rp->ai_protocol);
    if(fd<0) continue;
    if(connect(fd,rp->ai_addr,rp->ai_addrlen)==0) break;
    close(fd); fd=-1;
  }
  freeaddrinfo(res); return fd;
}
static http_resp http_request(const char *server, const char *method, const char *path,
                              const char *token, const char *body){
  char host[256], port[32]; strncpy(host,server,255); host[255]=0;
  char *colon=strrchr(host,':');
  if(colon){ strcpy(port,colon+1); *colon=0; } else strcpy(port,"80");
  http_resp r={0,0,0};
  int fd=tcp_connect(host,port);
  if(fd<0) return r;
  buf_t req={0};
  char line[2048];
  int bl=body?(int)strlen(body):0;
  snprintf(line,sizeof line,"%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n",method,path,server);
  buf_append(&req,line,strlen(line));
  if(token){ snprintf(line,sizeof line,"Authorization: Bearer %s\r\n",token); buf_append(&req,line,strlen(line)); }
  if(bl){ snprintf(line,sizeof line,"Content-Type: application/json\r\nContent-Length: %d\r\n",bl); buf_append(&req,line,strlen(line)); }
  buf_append(&req,"\r\n",2);
  if(bl) buf_append(&req,body,bl);
  size_t off=0;
  while(off<req.len){ ssize_t w=write(fd,req.base+off,req.len-off); if(w<=0) break; off+=w; }
  free(req.base);

  buf_t raw={0}; char tmp[8192]; ssize_t n;
  while((n=read(fd,tmp,sizeof tmp))>0) buf_append(&raw,tmp,n);
  close(fd);
  if(raw.len==0) return r;
  char *hbase=raw.base;
  char *hdr_end=strstr(hbase,"\r\n\r\n");
  if(!hdr_end) return r;
  int major,minor,code;
  if(sscanf(hbase,"HTTP/%d.%d %d",&major,&minor,&code)!=3) return r;
  r.status=code;
  char *body_start=hdr_end+4;
  size_t hlen=(size_t)(hdr_end-hbase);
  char saved=hbase[hlen]; hbase[hlen]=0;
  long clen=-1;
  for(char*p=hbase;;){
    char*e=strstr(p,"\r\n"); if(!e) break;
    if(!strncasecmp(p,"Content-Length:",15)) clen=strtol(p+15,NULL,10);
    p=e+2;
  }
  hbase[hlen]=saved;
  size_t remain=raw.len-(size_t)(body_start-raw.base);
  int chunked=0;
  for(char*p=hbase;;){ char*e=strstr(p,"\r\n"); if(!e) break;
    if(!strncasecmp(p,"Transfer-Encoding: chunked",25)){ chunked=1; }
    p=e+2; }
  buf_t out={0};
  if(chunked){
    char *p=body_start;
    while(p < body_start+remain){
      char*e=strstr(p,"\r\n"); if(!e) break;
      long sz=strtol(p,NULL,16); if(sz<=0) break;
      buf_append(&out,e+2,sz); p=e+2+sz+2;
    }
  } else {
    size_t take = clen>=0 && (size_t)clen<=remain ? (size_t)clen : remain;
    buf_append(&out,body_start,take);
  }
  free(raw.base);
  r.body=out.base; r.len=out.len; return r;
}

/* ---------------- 应用逻辑 ---------------- */
typedef struct {
  const char *server, *room, *token, *mode, *cache_path;
  long long shift_ms; int meeting_id; int once;
} args_t;

static long long now_ms(void){ struct timespec ts; clock_gettime(CLOCK_REALTIME,&ts);
  return (long long)ts.tv_sec*1000+ts.tv_nsec/1000000; }

static int file_write_all(const char*path,const char*s){ FILE*f=fopen(path,"w"); if(!f)return -1;
  fputs(s,f); fclose(f); return 0; }
static char *file_read_all(const char*path){ FILE*f=fopen(path,"r"); if(!f)return NULL;
  fseek(f,0,SEEK_END); long n=ftell(f); fseek(f,0,SEEK_SET); char*b=malloc(n+1);
  fread(b,1,n,f); b[n]=0; fclose(f); return b; }

/* 拉状态（带设备时钟上报）；成功落缓存。失败返回 NULL，调用方回退缓存。 */
static char *fetch_state(args_t *a, long long device_ms){
  char path[512];
  snprintf(path,sizeof path,"/api/displays/%s/state?deviceMs=%lld",a->room,device_ms);
  http_resp r=http_request(a->server,"GET",path,NULL,NULL);
  if(r.status==200 && r.body){ file_write_all(a->cache_path,r.body); return r.body; }
  if(r.status==304){ char*c=file_read_all(a->cache_path); if(c) return c; }
  free(r.body);
  return NULL;
}

static const char *zh_status(const char*s){
  if(!s) return "未知";
  if(!strcmp(s,"free")) return "空闲";
  if(!strcmp(s,"occupied")) return "使用中（未签到）";
  if(!strcmp(s,"occupied_checkedin")) return "使用中";
  return s;
}
static void iso8601(long long ms,char*out,size_t n){ time_t t=ms/1000; struct tm tm;
  gmtime_r(&t,&tm); (void)snprintf(out,n,"%04d-%02d-%02dT%02d:%02dZ",tm.tm_year+1900,tm.tm_mon+1,tm.tm_mday,tm.tm_hour,tm.tm_min); }

/* 渲染：背景层与状态层分离；背景拉取失败不遮挡状态 */
static void render_sign(args_t *a, const char *json){
  const char *p=json; JVal *root=j_parse(&p);
  if(!root){ printf("（状态解析失败，使用最后已知状态文字）\n"); return; }
  JVal *mt0=j_get(root,"meeting"), *dsp=j_get(root,"display"), *tpl=j_get(root,"template"), *nx0=j_get(root,"next");
  JVal *mt=j_isnull(mt0)?NULL:mt0, *nx=j_isnull(nx0)?NULL:nx0;
  const char *status=j_str(root,"status");
  int is_priv = j_str(root,"privacy") && !strcmp(j_str(root,"privacy"),"private");

  /* 背景层（尽力而为）：HEAD/GET 模板资源；失败仅记录 bg_ok=0 */
  int bg_ok=1; const char *bg_url=tpl?j_str(tpl,"backgroundUrl"):NULL;
  if(bg_url && strncmp(bg_url,"/static/",8)==0){
    http_resp b=http_request(a->server,"GET",bg_url,NULL,NULL);
    if(b.status!=200) bg_ok=0;
    free(b.body);
  }

  printf("\033[2J\033[H");
  printf("╔══════════════════════════════════════════════════════════╗\n");
  printf("║  ACME 会议室门牌 %-40s ║\n", "");
  printf("╠══════════════════════════════════════════════════════════╣\n");
  printf("║  状态: %-48s║\n", zh_status(status));
  if(mt){
    const char *topic=j_str(mt,"topic");
    printf("║  会议: %-48s║\n", (!topic||is_priv) ? "使用中（隐私模式，主题隐藏）" : topic);
    char s[40], e[40];
    iso8601(j_ms(mt,"startMs"),s,sizeof s); iso8601(j_ms(mt,"endMs"),e,sizeof e);
    printf("║  时间(UTC): %s ~ %s  v%-18d║\n", s, e, (int)j_numd(mt,"version"));
    const char *ch=j_str(mt,"challenge");
    if(ch) printf("║  签到码: %-46s║\n", ch);
  } else {
    printf("║  会议: %-48s║\n", "—");
  }
  if(nx){ const char*t=j_str(nx,"topic"); char s[32]; iso8601(j_ms(nx,"startMs"),s,sizeof s);
    printf("║  下一场: %s @ %-35s║\n", (is_priv||!t)?"(隐藏)":t, s); }
  printf("║  背景层: %-48s║\n", bg_ok?"公司模板已加载 ✓":"加载失败（状态仍正常显示）⚠");
  if(dsp){
    int fresh = j_get(dsp,"fresh") && j_get(dsp,"fresh")->t==J_BOOL && j_numd(dsp,"fresh")==1;
    printf("║  设备新鲜度: %-42s║\n", fresh?"在线新鲜 ✓":"陈旧/离线 ⚠");
    printf("║  服务器时钟偏差: %-37lld ms ║\n", (long long)j_numd(dsp,"clockOffsetMs"));
  }
  long long srv=j_ms(root,"serverMs"); char z[32]; iso8601(srv,z,sizeof z);
  printf("║  服务器时间: %-45s║\n", z);
  printf("╚══════════════════════════════════════════════════════════╝\n");
  printf("(半开区间 [start,end)；跨会议边界以服务器重拉为准，本地不倒计时翻场)\n");
}

/* 离线队列文件：JSON {"policy":..., "items":[{meetingId,...}]}，由 checkin 追加 */
static void queue_add(args_t *a){
  char qpath[512]; snprintf(qpath,sizeof qpath,"%s.queue",a->cache_path);
  char *old=file_read_all(qpath);
  FILE*f=fopen(qpath,"w"); if(!f){ perror("queue"); return; }
  if(old){
    /* 在 items 数组末尾插入 */
    char *p=strstr(old,"\"items\""); char *lb=p?strchr(p,'['):NULL;
    if(lb){ char*rb=strrchr(old,']');
      fwrite(old,1,lb-old+1,f);
      if(rb>lb+1) fwrite(lb+1,1,rb-lb-1,f); /* 原有内容 */
      if(rb>lb+1) fputc(',',f);
      fprintf(f,"{\"meetingId\":%d,\"atMs\":%lld,\"offline\":true}",a->meeting_id,now_ms()+a->shift_ms);
      fwrite(rb,1,(old+strlen(old))-rb,f);
      free(old); fclose(f); printf("离线排队成功（断网，已写本地队列）\n"); return;
    }
    free(old);
  }
  fprintf(f,"{\"items\":[{\"meetingId\":%d,\"atMs\":%lld,\"offline\":true}]}",a->meeting_id,now_ms()+a->shift_ms);
  fclose(f); printf("离线排队成功（断网，已写本地队列）\n");
}

/* 重连后把本地队列一次性提交；对每条返回确定结果（成功/被撤销/改期不匹配/已过期） */
static void queue_flush(args_t *a){
  char qpath[512]; snprintf(qpath,sizeof qpath,"%s.queue",a->cache_path);
  char *q=file_read_all(qpath);
  if(!q){ printf("（无离线队列）\n"); return; }
  /* 取当前时钟校准：先心跳一次拿 display.clockOffsetMs */
  char *st=fetch_state(a, now_ms()+a->shift_ms);
  long long off=0;
  if(st){ const char*pp=st; JVal*r=j_parse(&pp); JVal*d=j_get(r,"display");
    if(d) off=j_ms(d,"clockOffsetMs"); }
  /* 构造提交体：直接复用 items，补 deviceMs（校准前设备自报） */
  /* 直接用队列文件里的 items 数组拼 body（队列文件本身就是 {items:[...]}） */
  const char *lb=strchr(q,'[');
  char items[2048]; items[0]=0;
  if(lb){ const char*rb=strrchr(lb,']');
    size_t n=(size_t)(rb-lb+1); if(n>=sizeof items) n=sizeof items-1;
    memcpy(items,lb,n); items[n]=0; }
  else strcpy(items,"[]");
  char body[4096];
  snprintf(body,sizeof body,"{\"deviceMs\":%lld,\"queue\":%s}",
    now_ms()+a->shift_ms, items);
  char path[256]; snprintf(path,sizeof path,"/api/displays/%s/checkins",a->room);
  http_resp r=http_request(a->server,"POST",path,a->token,body);
  printf("离线签到补提 HTTP %d\n%s\n", r.status, r.body?r.body:"(无响应)");
  if(r.status==207) remove(qpath);   /* 全部裁决完成（含拒绝），清掉旧确认 */
  free(r.body); free(q); (void)off;
}

/* 签到模式：在线直接 POST；带 --offline 模拟断网则只排队 */
static void mode_checkin(args_t *a, int offline){
  if(offline){ queue_add(a); return; }
  char body[128]; snprintf(body,sizeof body,"{}");
  char path[256]; snprintf(path,sizeof path,"/api/meetings/%d/checkin",a->meeting_id);
  http_resp r=http_request(a->server,"POST",path,a->token,body);
  printf("签到 HTTP %d: %s\n", r.status, r.body?r.body:"(无响应)");
  free(r.body);
}

/* 时钟漂移演示：连续两次心跳，观察 serverMs/deviceMs 校准 */
static void mode_skew(args_t *a){
  for(int i=0;i<2;i++){
    long long dev=now_ms()+a->shift_ms;
    char*st=fetch_state(a,dev);
    if(st){ const char*p=st; JVal*r=j_parse(&p); JVal*d=j_get(r,"display");
      printf("心跳%d: deviceMs=%lld serverMs=%lld 服务器记录 clockOffsetMs=%lld\n",
        i+1, dev, j_ms(r,"serverMs"), d?j_ms(d,"clockOffsetMs"):0);
      free(st);
    } else printf("心跳%d 失败（回退缓存渲染）\n",i+1);
  }
}

int main(int argc,char**argv){
  args_t a={ .server="127.0.0.1:8080", .room="1", .token=NULL, .mode="render",
             .cache_path="/tmp/doorsign-cache.json", .shift_ms=0, .meeting_id=0, .once=0 };
  int offline=0;
  for(int i=1;i<argc;i++){
    if(!strcmp(argv[i],"--server")&&i+1<argc) a.server=argv[++i];
    else if(!strcmp(argv[i],"--room")&&i+1<argc) a.room=argv[++i];
    else if(!strcmp(argv[i],"--token")&&i+1<argc) a.token=argv[++i];
    else if(!strcmp(argv[i],"--mode")&&i+1<argc) a.mode=argv[++i];
    else if(!strcmp(argv[i],"--cache")&&i+1<argc) a.cache_path=argv[++i];
    else if(!strcmp(argv[i],"--shift-ms")&&i+1<argc) a.shift_ms=atoll(argv[++i]);
    else if(!strcmp(argv[i],"--meeting")&&i+1<argc) a.meeting_id=atoi(argv[++i]);
    else if(!strcmp(argv[i],"--once")) a.once=1;
    else if(!strcmp(argv[i],"--offline")) offline=1;
  }
  if(!strcmp(a.mode,"checkin")){ mode_checkin(&a,offline); return 0; }
  if(!strcmp(a.mode,"queue")){ queue_flush(&a); return 0; }
  if(!strcmp(a.mode,"simskew")){ mode_skew(&a); return 0; }
  if(!strcmp(a.mode,"probe")){
    /* probe: 能拉到服务器就打印 LIVE+状态摘要；否则打印 CACHED+缓存摘要 */
    char*st=fetch_state(&a, now_ms()+a.shift_ms);
    if(st){ printf("LIVE\n"); render_sign(&a,st); free(st); }
    else { char*c=file_read_all(a.cache_path);
      printf("OFFLINE — 使用缓存\n");
      if(c){ render_sign(&a,c); free(c);} else printf("无缓存\n"); }
    return 0;
  }
  /* render: 默认单次（测试）或循环 */
  do {
    char*st=fetch_state(&a, now_ms()+a.shift_ms);
    if(st){ render_sign(&a,st); free(st); }
    else { char*c=file_read_all(a.cache_path);
      printf("[网络不可达 — 渲染最后缓存]\n");
      if(c){ render_sign(&a,c); free(c);} }
    if(a.once) break;
    sleep(10);
  } while(1);
  return 0;
}
