# Contested History: API + built frontend in one image. MariaDB runs as its own service
# (docker-compose.yml). On a Verda CPU instance:  docker compose --profile app up -d --build

FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY common/ common/
COPY db/ db/
COPY ingest/ ingest/
COPY scoring/ scoring/
COPY api/ api/
COPY dev.py ./
COPY --from=web /web/dist web/dist
ENV DB_HOST=mariadb DB_PORT=3306 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["sh", "-c", "python -m common.schema && uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers 2"]
