# Pennystead for a home server / NAS. The app has no dependencies, so the image is just Node + the source.
FROM node:22-slim
ENV NODE_ENV=production PENNYSTEAD_HOST=0.0.0.0 PENNYSTEAD_DATA=/data PENNYSTEAD_NO_BROWSER=1 PENNYSTEAD_NO_ENV=1
WORKDIR /app
COPY package.json main.js server.js cli.js mcp.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3456
# Listening on the network is only allowed with a password: the container exits with an explanation if PENNYSTEAD_PASSWORD is not set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PENNYSTEAD_PORT||3456)+'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.js", "--no-browser"]
