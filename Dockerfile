# Alpine + nodejs (no npm/yarn) — smallest practical Node-on-Alpine image.
FROM alpine:3.20

RUN apk add --no-cache nodejs

WORKDIR /app
COPY index.html styles.css app.js server.js ./

EXPOSE 80
USER nobody

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

CMD ["node", "server.js"]
