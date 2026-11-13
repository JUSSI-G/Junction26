"""Create the database (DB_NAME from .env) and the tables in schema.sql.

    .venv\\Scripts\\python create_tables.py

Safe to run again: existing tables are left as they are.
"""
import os, re
from common import connect, DB, ROOT

con = connect(database=False)
cur = con.cursor()
cur.execute(f"CREATE DATABASE IF NOT EXISTS `{DB['database']}` CHARACTER SET utf8mb4")
cur.execute(f"USE `{DB['database']}`")
# Drop -- comments first: one may contain a ';', which would split a statement.
sql = re.sub(r"--[^\n]*", "", open(os.path.join(ROOT, "schema.sql"), encoding="utf-8").read())
for statement in sql.split(";"):
    if statement.strip():
        cur.execute(statement)
cur.execute("SELECT VERSION()")
version = cur.fetchone()[0]
cur.execute("SHOW TABLES")
print(f"MariaDB {version}, database {DB['database']} on port {DB['port']}:",
      ", ".join(t for (t,) in cur.fetchall()))
con.close()
