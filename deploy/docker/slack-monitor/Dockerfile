FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY slack_monitor ./slack_monitor
ENTRYPOINT ["python3", "-m", "slack_monitor.main"]
