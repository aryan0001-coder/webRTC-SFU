FROM node:20-alpine

WORKDIR /app
COPY package-lock.json .
COPY package.json .

# Install required dependencies for mediasoup build
RUN apk add --no-cache \
    python3 \
    py3-pip \
    build-base \
    linux-headers \
    musl-dev \
    pkgconfig \
    libtool \
    autoconf \
    automake \
    cmake \
    ninja \
    meson && \
    npm install

COPY src src
COPY ssl ssl
COPY public public

EXPOSE 3016
EXPOSE 10000-10100

RUN npm i -g nodemon

CMD npm start