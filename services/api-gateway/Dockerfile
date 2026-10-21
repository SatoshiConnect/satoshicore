# SatoshiCore Web Wallet API Gateway — production image (zero dependencies)
FROM node:20-alpine AS base
RUN addgroup -S gateway && adduser -S gateway -G gateway
WORKDIR /app
COPY server.js package.json ./
USER gateway
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
