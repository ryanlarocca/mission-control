"""A tiny in-memory PostgREST stand-in for the market-cycle --write paths (tests only).

Supports what the scripts use: GET with select / eq. / is.null / is.true / lte. /
order=<col>.desc / limit; POST with on_conflict + Prefer resolution=merge-duplicates |
ignore-duplicates and return=representation; PATCH with the same filters. Unique keys
mirror the migrations. Never talks to the network beyond 127.0.0.1.
"""
import json, socketserver, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class _Server(ThreadingHTTPServer):
    def server_bind(self):                      # skip HTTPServer's reverse-DNS getfqdn() (slow, and not needed)
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

UNIQUE = {
    "cycle_thesis_versions": ["version"], "cycle_claims": ["id"], "cycle_dials": ["id"],
    "cycle_readings": ["dial_id", "variant", "as_of", "source_url"], "cycle_checkpoints": ["id"],
    "cycle_weight_moves": ["id"], "cycle_owned_properties": ["id"], "cycle_calendar": ["id"],
    "cycle_notes": ["dial_id", "text"],
}
DEFAULTS = {"cycle_readings": {"variant": ""}, "cycle_notes": {"kind": "release", "surfaced_at": None},
            "cycle_calendar": {"fired_at": None, "tentative": False}, "cycle_claims": {"status": "open"},
            "cycle_owned_properties": {"retired_at": None}}
SERIAL = {"cycle_readings", "cycle_notes", "cycle_calendar", "cycle_weight_moves", "cycle_owned_properties"}


class FakePostgrest:
    def __init__(self, tables=None):
        self.tables = {t: [] for t in (tables or UNIQUE)}
        self.seq = {}
        self.calls = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _parse(self):
                u = urllib.parse.urlsplit(self.path)
                table = u.path.split("/rest/v1/", 1)[-1]
                params = urllib.parse.parse_qsl(u.query, keep_blank_values=True)
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                return table, params, body

            def _send(self, code, obj=None):
                data = b"" if obj is None else json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method):
                table, params, body = self._parse()
                fake.calls.append((method, table, params))
                if table not in fake.tables:
                    return self._send(404, {"message": "relation %s does not exist" % table})
                try:
                    code, out = fake.handle(method, table, params, body, self.headers.get("Prefer") or "")
                except KeyError as e:
                    return self._send(400, {"message": "column %s does not exist" % e})
                self._send(code, out)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            def do_PATCH(self):
                self._handle("PATCH")

        self.server = _Server(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    # ------------------------------------------------------------------
    @staticmethod
    def _match(row, filters):
        for col, op, val in filters:
            v = row.get(col)
            if op == "eq" and str(v) != val and not (isinstance(v, bool) and str(v).lower() == val):
                return False
            if op == "is" and ((val == "null" and v is not None) or (val == "true" and v is not True)):
                return False
            if op == "lte" and (v is None or str(v) > val):
                return False
        return True

    def handle(self, method, table, params, body, prefer):
        rows = self.tables[table]
        filters, select, order, limit, on_conflict = [], None, None, None, None
        for k, v in params:
            if k == "select":
                select = v
            elif k == "order":
                order = v
            elif k == "limit":
                limit = int(v)
            elif k == "on_conflict":
                on_conflict = v.split(",")
            elif k == "columns":
                pass
            else:
                op, _, val = v.partition(".")
                filters.append((k, op, val))
        if method == "GET":
            out = [r for r in rows if self._match(r, filters)]
            if order:
                col, _, direction = order.partition(".")
                out.sort(key=lambda r: str(r.get(col)), reverse=direction == "desc")
            if limit is not None:
                out = out[:limit]
            if select and select != "*":
                cols = select.split(",")
                for c in cols:
                    if out and c not in out[0] and c not in DEFAULTS.get(table, {}):
                        raise KeyError(c)
                out = [{c: r.get(c, DEFAULTS.get(table, {}).get(c)) for c in cols} for r in out]
            return 200, out
        if method == "PATCH":
            n = 0
            for r in rows:
                if self._match(r, filters):
                    r.update(body); n += 1
            return 204, None
        # POST
        key = on_conflict or UNIQUE[table]
        created = []
        for b in body if isinstance(body, list) else [body]:
            row = dict(DEFAULTS.get(table, {}), **b)
            if table in SERIAL and "id" not in row:
                self.seq[table] = self.seq.get(table, 0) + 1
                row["id"] = self.seq[table]
            hit = None
            if on_conflict:
                hit = next((r for r in rows if all(r.get(c) == row.get(c) for c in key)), None)
            if hit is not None:
                if "merge-duplicates" in prefer:
                    hit.update(b)
                elif "ignore-duplicates" in prefer:
                    continue
                else:
                    return 409, {"message": "duplicate key"}
                continue
            if not on_conflict and table not in SERIAL and any(all(r.get(c) == row.get(c) for c in key) for r in rows):
                return 409, {"message": "duplicate key"}
            rows.append(row)
            created.append(row)
        if "return=representation" in prefer:
            return 201, created
        return 201, None
