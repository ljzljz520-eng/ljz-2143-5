#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/stat.h>

#define MAX_JSON (1024 * 1024)

typedef struct {
    char host[256];
    char port[16];
    char token[8192];
    char cache_path[1024];
    int once;
    int poll_seconds;
    int simulate_offline;
} Config;

typedef struct { int status; char *body; size_t len; } HttpResponse;

static long now_ms(void) { struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL; }
static void die(const char *m) { fprintf(stderr, "%s\n", m); exit(2); }
static char *xstrdup(const char *s) { char *p = strdup(s ? s : ""); if (!p) die("oom"); return p; }

static char *json_string(const char *json, const char *key) {
    char pat[128]; snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(json, pat); if (!p) return NULL;
    p = strchr(p + strlen(pat), ':'); if (!p) return NULL;
    p++; while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return NULL;
    p++; const char *start = p;
    char *out = malloc(strlen(json) + 1); size_t n = 0;
    while (*p && *p != '"') {
        if (*p == '\\' && p[1]) {
            p++;
            switch (*p) { case 'n': out[n++]='\n'; break; case 't': out[n++]='\t'; break;
                case 'r': out[n++]='\r'; break; case '"': out[n++]='"'; break;
                case '\\': out[n++]='\\'; break; case '/': out[n++]='/'; break;
                default: out[n++]=*p; }
            p++;
        } else out[n++] = *p++;
    }
    out[n] = 0; (void)start; return out;
}

static long long json_number(const char *json, const char *key) {
    char pat[128]; snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(json, pat); if (!p) return -1;
    p = strchr(p + strlen(pat), ':'); if (!p) return -1;
    return strtoll(p + 1, NULL, 10);
}

static HttpResponse http_request(const char *host, const char *port, const char *method, const char *path, const char *token, const char *body) {
    struct addrinfo hints = {0}, *res = NULL, *rp;
    hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    int e = getaddrinfo(host, port, &hints, &res);
    if (e) { fprintf(stderr, "DNS failed: %s\n", gai_strerror(e)); exit(3); }
    int fd = -1;
    for (rp = res; rp; rp = rp->ai_next) { fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol); if (fd >= 0 && connect(fd, rp->ai_addr, rp->ai_addrlen) == 0) break; close(fd); fd = -1; }
    freeaddrinfo(res); if (fd < 0) { HttpResponse r = {0, NULL, 0}; return r; }

    char req[12000];
    int n = snprintf(req, sizeof req,
        "%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\nX-Device-Token: %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n%s",
        method, path, host, token, body ? strlen(body) : 0, body ? body : "");
    if (n >= (int)sizeof req) die("HTTP request too large");
    if ((ssize_t)write(fd, req, (size_t)n) != (ssize_t)n) { close(fd); HttpResponse r={0,NULL,0}; return r; }

    size_t cap = 8192, len = 0; char *buf = malloc(cap);
    for (;;) {
        if (len + 4096 >= cap) { cap *= 2; buf = realloc(buf, cap); if (!buf) die("oom"); }
        ssize_t got = read(fd, buf + len, cap - len - 1);
        if (got < 0) { if (errno == EINTR) continue; break; }
        if (got == 0) break;
        len += (size_t)got;
    }
    close(fd); buf[len] = 0;
    char *body_start = strstr(buf, "\r\n\r\n");
    HttpResponse r;
    if (!body_start) { r.status=0; r.body=xstrdup(buf); r.len=len; free(buf); return r; }
    body_start += 4;
    r.status = atoi(buf + 9);
    r.len = len - (size_t)(body_start - buf);
    r.body = malloc(r.len + 1); memcpy(r.body, body_start, r.len); r.body[r.len]=0;
    free(buf); return r;
}

static void save_text_file(const char *path, const char *data, size_t len) {
    FILE *f = fopen(path, "w");
    if (!f) return;
    fwrite(data, 1, len, f);
    fclose(f);
}

static void save_cache(const Config *c, const char *json) {
    char wrapper[MAX_JSON + 2048];
    snprintf(wrapper, sizeof wrapper, "{\"cachedAtUtc\":%lld,\"snapshot\":%s}", (long long)now_ms(), json);
    save_text_file(c->cache_path, wrapper, strlen(wrapper));
}

static char *asset_path_for(const Config *c) {
    static char p[1100];
    snprintf(p, sizeof p, "%s-background", c->cache_path);
    return p;
}

static int refresh_template_asset(const Config *c, const char *snap) {
    char *url = json_string(snap, "backgroundUrl");
    if (!url || url[0] == 0) { free(url); return 0; }
    HttpResponse a = http_request(c->host, c->port, "GET", url, c->token, NULL);
    int ok = (a.status == 200 && a.body && a.len > 0);
    if (ok) save_text_file(asset_path_for(c), a.body, a.len);
    free(a.body); free(url);
    return ok;
}


static char *receipt_path_for(const Config *c) {
    static char p[1100];
    snprintf(p, sizeof p, "%s-receipts.jsonl", c->cache_path);
    return p;
}

static void queue_receipt(const Config *c, const char *snap, long long meeting_id) {
    long long servertime = json_number(snap, "serverTimeUtc");
    long long client = now_ms();
    char confirmation[256];
    snprintf(confirmation, sizeof confirmation, "door-%lld-%lld-%lld", (long long)meeting_id, servertime, client);
    char body[1024];
    snprintf(body, sizeof body,
      "{\"meetingId\":%lld,\"clientClockUtc\":%lld,\"lastKnownServerClockUtc\":%lld,\"maxAbsClockSkewMs\":300000,\"confirmation\":\"%s\"}",
      (long long)meeting_id, client, servertime, confirmation);
    FILE *f = fopen(receipt_path_for(c), "a");
    if (f) { fputs(body, f); fputc('\n', f); fclose(f); }
}

static void upload_receipts(const Config *c) {
    FILE *f = fopen(receipt_path_for(c), "r");
    if (!f) return;
    char line[1024];
    int uploaded = 0, failed = 0;
    while (fgets(line, sizeof line, f)) {
        if (line[0] != '{') continue;
        HttpResponse r = http_request(c->host, c->port, "POST", "/api/door/checkin", c->token, line);
        if (r.status == 200) {
            uploaded++;
            char *status = json_string(r.body, "status");
            fprintf(stderr, "offline receipt reconciled: %s\n", status ? status : "decided");
            free(status);
        } else {
            failed++;
            fprintf(stderr, "offline receipt upload failed: HTTP %d; retaining queue\n", r.status);
        }
        free(r.body);
        if (failed > 0) { fclose(f); return; }
    }
    fclose(f);
    if (uploaded > 0 && failed == 0) remove(receipt_path_for(c));
}

static char *load_cache(const Config *c) {
    FILE *f = fopen(c->cache_path, "r"); if (!f) return NULL;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *b = malloc((size_t)n + 1); if (fread(b, 1, (size_t)n, f) != (size_t)n) { free(b); fclose(f); return NULL; }
    b[n]=0; fclose(f); return b;
}

static const char *extract_snapshot(char *cache) {
    const char *p = strstr(cache, "\"snapshot\":"); if (!p) return NULL;
    p += strlen("\"snapshot\":"); while (*p==' ') p++; return p;
}

static char *find_current_meeting(const char *snap) {
    long long servernow = json_number(snap, "serverTimeUtc");
    const char *p = strstr(snap, "\"meetings\":["); if (!p) return NULL;
    p += strlen("\"meetings\":[");
    const char *end = strstr(p, "\n  ],"); if (!end) end = strchr(p, ']');
    while (p && p < end) {
        const char *open = strchr(p, '{'); if (!open || open >= end) break;
        const char *close = strchr(open, '}'); if (!close) break;
        size_t n = (size_t)(close - open + 1); char item[8192]; if (n >= sizeof item) n=sizeof item-1;
        memcpy(item, open, n); item[n]=0;
        long long st = json_number(item, "startUtc"), en = json_number(item, "endUtc");
        if (servernow >= st && servernow < en) return xstrdup(item);
        p = close + 1;
    }
    return NULL;
}

static void render(const Config *c, const char *snap, int online, long long cached_at) {
    long long generated = json_number(snap, "generatedAtUtc");
    long long age_ms = now_ms() - generated;
    char *room = json_string(snap, "name");
    char *policy = strstr(snap, "offline_checkin_allowed") ? xstrdup("offline_checkin_allowed") : xstrdup("cache_view_only");
    char *cur = find_current_meeting(snap);
    char *subject = cur ? json_string(cur, "subject") : xstrdup("FREE / 空闲");
    char *status = cur ? json_string(cur, "status") : xstrdup("free");
    long long endUtc = cur ? json_number(cur, "endUtc") : 0;
    long long startUtc = cur ? json_number(cur, "startUtc") : 0;
    long long remaining = (endUtc - now_ms() + 500) / 1000;
    long long starts = (startUtc - now_ms() + 500) / 1000;

    printf("\033[2J\033[H");
    printf("\033[1;44;37m\n");
    printf("======================================\n");
    printf("        ACME 公司会议室门牌 (C)\n");
    printf("======================================\033[0m\n");
    printf("房间: %s\n", room ? room : "unknown");
    char *bg = json_string(snap, "backgroundUrl");
    struct stat st; memset(&st, 0, sizeof st);
    int bgCached = stat(asset_path_for(c), &st) == 0 && st.st_size > 0;
    printf("背景模板: %s；本地缓存=%s（背景失败不遮挡本状态层）\n",
           bg ? bg : "unset", bgCached ? "available" : online ? "load failed/missing" : "showing stale/last known status only");
    free(bg);
    printf("当前事实: \033[1m%s\033[0m [%s]\n", subject, status);
    if (cur && now_ms() >= endUtc)
        printf("会议边界已过（离线）: 旧缓存事实结束于 %lld UTC；状态标记 UNKNOWN/STALE，不续算下一场\n", endUtc);
    else if (cur) printf("会议边界: 半开区间 [%lld, %lld) UTC; 剩余约 %lld 分%lld 秒\n", startUtc, endUtc, remaining/60, remaining%60);
    else if (!online) printf("离线缓存无法确认跨边界后的当前会议：UNKNOWN/STALE\n");
    else printf("下一场将在约 %lld 分%lld 秒后开始\n", starts/60, starts%60);
    printf("\n设备策略: %s\n", policy);
    if (online) printf("\033[32m在线新鲜\033[0m: snapshot generated %llds ago\n", age_ms/1000);
    else {
        long long cache_age = (now_ms() - cached_at + 500)/1000;
        printf("\033[33m离线缓存\033[0m: cache age=%llds; 显示 %s\n", cache_age, strcmp(policy, "offline_checkin_allowed")==0 ? "并允许本地签到回执" : "仅供查看，禁止写签到");
        printf("跨会议边界时以缓存边界提示“UNKNOWN/需重连”，不把旧会议倒计时改成新事实。\n");
    }
    printf("服务器 UTC: %lld | 本机 UTC: %lld | 偏差: %llds\n", generated, (long long)now_ms(), (long long)((now_ms()-generated)/1000));
    free(room); free(policy); free(cur); free(subject); free(status);
}

static void offline_receipt(const Config *c, const char *snap) {
    if (!strstr(snap, "\"offlinePolicy\":\"offline_checkin_allowed\"")) {
        printf("\n策略为 cache_view_only：未生成本地签到；仅可查看缓存。\n");
        return;
    }
    char *cur = find_current_meeting(snap);
    if (cur && now_ms() >= json_number(cur, "endUtc")) {
        printf("\n会议边界已过：不为旧缓存生成离线签到，重连后等待新服务端事实。\n");
        free(cur); return;
    }
    if (!cur) { printf("\n缓存中没有当前会议，不生成离线签到；断线跨过边界后必须等待服务器事实。\n"); return; }
    long long id = json_number(cur, "id");
    long long servertime = json_number(snap, "serverTimeUtc");
    queue_receipt(c, snap, id);
    printf("\n本地离线确认已入持久队列（重连后上传，服务端重新裁决）: meeting=%lld client=%lld lastServer=%lld\n", id, (long long)now_ms(), servertime);
    free(cur);
}

int main(int argc, char **argv) {
    Config c = {0}; snprintf(c.cache_path, sizeof c.cache_path, "/tmp/meeting-door-cache.json"); strcpy(c.port, "3000");
    int opt; while ((opt = getopt(argc, argv, "h:p:t:c:i:os")) != -1) switch (opt) {
        case 'h': snprintf(c.host,sizeof c.host,"%s",optarg); break;
        case 'p': snprintf(c.port,sizeof c.port,"%s",optarg); break;
        case 't': snprintf(c.token,sizeof c.token,"%s",optarg); break;
        case 'c': snprintf(c.cache_path,sizeof c.cache_path,"%s",optarg); break;
        case 'o': c.simulate_offline=1; break;
        case 'i': c.poll_seconds = atoi(optarg); break;
        case 's': c.once=1; break;
        default: fprintf(stderr,"usage: %s -h host -p port -t token [-c cache] [-i pollSeconds] [-o offline] [-s once]\n",argv[0]); return 2;
    }
    if (!c.host[0] || !c.token[0]) die("host (-h) and token (-t) are required");

    if (!c.simulate_offline) {
        HttpResponse r = http_request(c.host, c.port, "GET", "/api/door", c.token, NULL);
        if (r.status == 200) {
            save_cache(&c, r.body); refresh_template_asset(&c, r.body);
            render(&c, r.body, 1, now_ms());
            upload_receipts(&c);
            free(r.body);
            if (c.once) return 0;
        } else {
            fprintf(stderr, "online fetch failed HTTP %d; falling back to cache\n", r.status); free(r.body);
            char *cache = load_cache(&c); if (!cache) die("no cache available");
            long long cached_at = json_number(cache, "cachedAtUtc");
            const char *snap = extract_snapshot(cache); if (cached_at < 0) cached_at = json_number(snap ? snap : cache, "generatedAtUtc"); render(&c, snap ? snap : cache, 0, cached_at); offline_receipt(&c, snap ? snap : cache); free(cache);
            return c.once ? 0 : 0;
        }
    } else {
        char *cache = load_cache(&c); if (!cache) die("offline mode requires an existing cache");
        long long cached_at = json_number(cache, "cachedAtUtc");
            const char *snap = extract_snapshot(cache); if (cached_at < 0) cached_at = json_number(snap ? snap : cache, "generatedAtUtc"); render(&c, snap ? snap : cache, 0, cached_at); offline_receipt(&c, snap ? snap : cache); free(cache);
        return 0;
    }
    if (c.poll_seconds > 0) {
        for (;;) {
            sleep((unsigned)c.poll_seconds);
            HttpResponse r = http_request(c.host, c.port, "GET", "/api/door", c.token, NULL);
            if (r.status == 200) {
                save_cache(&c, r.body);
                refresh_template_asset(&c, r.body);
                render(&c, r.body, 1, now_ms());
                upload_receipts(&c);
                free(r.body);
            } else {
                fprintf(stderr, "refresh failed HTTP %d; retaining displayed cache\n", r.status);
                free(r.body);
            }
        }
    }
    return 0;
}
