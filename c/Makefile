CC ?= gcc
CFLAGS ?= -std=c99 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -O2
doorsign: doorsign.c
	$(CC) $(CFLAGS) -o doorsign doorsign.c
clean:
	rm -f doorsign
.PHONY: clean
