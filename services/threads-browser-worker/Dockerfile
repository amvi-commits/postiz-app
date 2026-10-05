FROM mcr.microsoft.com/playwright/python:v1.40.0-jammy

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    THREADS_BROWSER_SERVICE_HOST=0.0.0.0 \
    THREADS_BROWSER_SERVICE_PORT=8017

# Copy dependency specifications
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Ensure sessions and diagnostics directories exist with proper write permissions for pwuser
RUN mkdir -p /app/sessions /app/diagnostics && \
    chown -R pwuser:pwuser /app && \
    chmod 750 /app/sessions /app/diagnostics

USER pwuser

EXPOSE 8017

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8017"]
