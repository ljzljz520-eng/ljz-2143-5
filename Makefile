.PHONY: test client start

node_modules:
	npm install

test: node_modules
	npm test

client:
	gcc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Wpedantic -o client/door_client client/door_client.c

start: node_modules
	node src/server.js
