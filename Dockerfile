# node:22-alpine resolves to the current 22.x LTS, which is past 22.12 -- the
# release that added server.listen({ reusePort }). Below that the server still
# runs; it just falls back to a shared listening handle.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# There is no `npm install` step because there are no dependencies. package.json
# is copied for its engines field and start script, nothing else.
COPY package.json ./
COPY src ./src
COPY public ./public

# node:* images ship an unprivileged `node` user. Nothing here needs root.
USER node

EXPOSE 8080

# Uses the app's own /health route, so the check fails if the event loop is
# wedged rather than merely if the process exists.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
