# COLD SECTOR: the site, the match workers and the built client in one image.
# The server bundle, the client and the game assets are built here, at image build time, so `npm start`
# finds everything up to date and starts the server straight away.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /app/user && chown -R node:node /app/user /app/build /app/client/dist
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5000 USER_DIR=/app/user
USER node
VOLUME /app/user
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:5000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["npm", "start"]
