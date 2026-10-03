# node:sqlite deja de ser experimental a partir de Node 24
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY *.js ./
COPY public ./public

# la base y los respaldos viven en un volumen, fuera de la imagen,
# para que sobrevivan a cada despliegue
ENV NODE_ENV=production \
    PORT=8080 \
    BITACORA_DB=/datos/bitacora.db \
    BITACORA_RESPALDOS=/datos/respaldos \
    BITACORA_ARCHIVO=/datos/archivo
VOLUME /datos
EXPOSE 8080

CMD ["node", "server.js"]
