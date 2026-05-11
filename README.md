# UniFi Statistics

Read-only UniFi network awareness dashboard by ScottiBYTE.

## Features

- Real-time client tracking  
- Recently detected clients  
- Recently offline clients  
- Recently returned clients  
- Unnamed device identification  
- Bandwidth history graph  

---

## Quick Start

### .env

UNIFI_URL=https://192.168.1.1  
UNIFI_USERNAME=your_username  
UNIFI_PASSWORD='your_password_here'  
UNIFI_SITE=default  
PORT=3050  

---

### docker-compose.yml

services:
  unifi-statistics:
    image: scottibyte/unifi-statistics:v1.0
    container_name: unifi-statistics
    restart: unless-stopped
    ports:
      - "80:3050"
    env_file:
      - .env
    volumes:
      - ./data:/app/data

---

## Run

docker compose up -d

---

## Access

http://SERVER-IP/

---

## Notes

- Password must be quoted if it contains `$`
- Data is stored in ./data
- No config.json required

---

## Tags

latest = current build  
v1.0 = initial stable release
