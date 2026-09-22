FROM python:3.11-slim
RUN pip install --no-cache-dir prometheus-client docker
COPY gpu_process_exporter.py /app/gpu_process_exporter.py
ENTRYPOINT ["python3", "/app/gpu_process_exporter.py"]
