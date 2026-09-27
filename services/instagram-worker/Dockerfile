FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    IG_DATA_DIR=/data \
    IG_MEDIA_ROOT=/uploads

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY tests ./tests

RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /data /uploads \
    && chown -R appuser:appuser /app /data /uploads
USER appuser

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
