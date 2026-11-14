# Thin wrapper over dev.py (which also works on Windows: python dev.py <task>).
DATASET ?= demo
PAGES ?=

.PHONY: db ingest score api web web-mock mocks test demo
db:       ; python dev.py db
ingest:   ; python dev.py ingest $(DATASET) $(PAGES)
score:    ; python dev.py score
api:      ; python dev.py api
web:      ; python dev.py web
web-mock: ; python dev.py web-mock
mocks:    ; python dev.py mocks
test:     ; python dev.py test
demo:     ; python dev.py demo
