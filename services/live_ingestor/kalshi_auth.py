from __future__ import annotations

import base64
import time
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


class KalshiAuth:
    def __init__(self, key_id: str, private_key_path: str):
        self.key_id = key_id
        self.private_key = self._load_key(private_key_path)

    def _load_key(self, private_key_path: str):
        with Path(private_key_path).open("rb") as handle:
            return serialization.load_pem_private_key(handle.read(), password=None)

    def sign(self, timestamp_ms: str, method: str, path: str) -> str:
        path_without_query = path.split("?", 1)[0]
        message = f"{timestamp_ms}{method.upper()}{path_without_query}".encode("utf-8")
        signature = self.private_key.sign(
            message,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH,
            ),
            hashes.SHA256(),
        )
        return base64.b64encode(signature).decode("utf-8")

    def headers(self, method: str, path: str) -> dict[str, str]:
        timestamp_ms = str(int(time.time() * 1000))
        return {
            "KALSHI-ACCESS-KEY": self.key_id,
            "KALSHI-ACCESS-SIGNATURE": self.sign(timestamp_ms, method, path),
            "KALSHI-ACCESS-TIMESTAMP": timestamp_ms,
        }

    def ws_headers(self) -> dict[str, str]:
        return self.headers("GET", "/trade-api/ws/v2")
