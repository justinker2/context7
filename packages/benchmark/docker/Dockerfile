ARG PY_VERSION=3.10
ARG OS_VARIANT=slim-bookworm
FROM python:${PY_VERSION}-${OS_VARIANT}

# System libs that GitChameleon's heavier libraries (geopandas, shapely, matplotlib,
# Pillow, scikit-image, librosa) link against. Installed at image build so per-sample
# pip installs are quick.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      pkg-config \
      git \
      curl \
      xz-utils \
      ca-certificates \
      libgeos-dev \
      libgdal-dev \
      libproj-dev \
      libfreetype6-dev \
      libpng-dev \
      libjpeg-dev \
      libsndfile1 \
      libopenblas-dev \
 && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --upgrade pip wheel setuptools \
 && python -m pip install --no-cache-dir pytest

WORKDIR /work
