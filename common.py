"""Shared settings and connection helper. Reads .env (never hard-code credentials)."""
import os, sys
import mariadb

# Finnish titles print correctly on Windows consoles and pipes.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

ROOT = os.path.dirname(os.path.abspath(__file__))

_env = os.path.join(ROOT, ".env")
if os.path.exists(_env):
    with open(_env, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                    value = value[1:-1]
                os.environ.setdefault(key.strip(), value)

DB = dict(host=os.environ.get("DB_HOST", "127.0.0.1"),
          port=int(os.environ.get("DB_PORT", 3306)),
          user=os.environ.get("DB_USER", "root"),
          password=os.environ.get("DB_PASSWORD", ""),
          database=os.environ.get("DB_NAME", "wiki"))


def connect(database=True):
    """Connect with time_zone UTC. database=False connects without selecting a database."""
    params = dict(DB)
    if not database:
        params.pop("database")
    con = mariadb.connect(**params, autocommit=False)
    cur = con.cursor()
    cur.execute("SET time_zone = '+00:00'")
    cur.close()
    return con
