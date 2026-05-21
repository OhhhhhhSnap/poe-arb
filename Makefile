PI_HOST   ?= 192.168.1.2
PI_USER   ?= pi
PI_DIR    ?= /opt/poe-arb
IMAGE     ?= poe-arb
PORT      ?= 5001
CONTAINER ?= poe-arb

.PHONY: build run stop logs restart deploy ssh

# ── local ────────────────────────────────────────────────────────────────────

build:
	docker build -t $(IMAGE) .

run: build
	@docker rm -f $(CONTAINER) 2>/dev/null || true
	docker run -d \
		--name $(CONTAINER) \
		--restart unless-stopped \
		-p $(PORT):5000 \
		$(shell [ -f .env ] && echo "--env-file .env") \
		$(IMAGE)
	@echo "Running at http://localhost:$(PORT)"

stop:
	docker rm -f $(CONTAINER) 2>/dev/null || true

logs:
	docker logs -f $(CONTAINER)

restart: stop run

# ── Pi deployment ─────────────────────────────────────────────────────────────

deploy:
	@echo "==> Syncing code to $(PI_USER)@$(PI_HOST):$(PI_DIR)"
	rsync -av --exclude='.git' --exclude='__pycache__' --exclude='*.pyc' \
		--exclude='.env' \
		. $(PI_USER)@$(PI_HOST):$(PI_DIR)/
	@if [ -f .env ]; then \
		echo "==> Copying .env"; \
		scp .env $(PI_USER)@$(PI_HOST):$(PI_DIR)/.env; \
	else \
		echo "WARN: no .env found — copy .env.example to .env and fill in values"; \
	fi
	@echo "==> Building and starting container on Pi"
	ssh $(PI_USER)@$(PI_HOST) "cd $(PI_DIR) && \
		docker build -t $(IMAGE) . && \
		docker rm -f $(CONTAINER) 2>/dev/null || true && \
		docker run -d \
			--name $(CONTAINER) \
			--restart unless-stopped \
			-p $(PORT):5000 \
			\$$([ -f .env ] && echo '--env-file .env') \
			$(IMAGE)"
	@echo "==> Deployed — http://$(PI_HOST):$(PORT)"

ssh:
	ssh $(PI_USER)@$(PI_HOST)
