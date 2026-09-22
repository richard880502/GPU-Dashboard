FROM python:3.11-slim
RUN pip install --no-cache-dir nvitop-exporter
ENTRYPOINT ["nvitop-exporter"]
CMD ["--bind-address", "0.0.0.0", "--port", "5050"]
