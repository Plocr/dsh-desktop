#!/usr/bin/env python3
"""
ui-dashboard 离线 token 统计：用官方 DeepSeek tokenizer（tokenizers 库）批量编码。

用法:
    python deepseek_tokenize.py <tokenizer_dir>   # stdin: {"texts": [..., ...]} -> stdout: [count, ...]
"""
import json
import os
import sys

from tokenizers import Tokenizer


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing tokenizer dir"}), file=sys.stderr)
        sys.exit(2)
    tok_dir = sys.argv[1]
    try:
        raw = sys.stdin.buffer.read()
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"bad stdin json: {exc}"}), file=sys.stderr)
        sys.exit(2)
    texts = payload.get("texts", [])
    tokenizer = Tokenizer.from_file(os.path.join(tok_dir, "tokenizer.json"))
    counts = []
    for text in texts:
        try:
            encoded = tokenizer.encode(text if isinstance(text, str) else str(text), add_special_tokens=False)
            counts.append(len(encoded.ids))
        except Exception:  # noqa: BLE001
            counts.append(0)
    print(json.dumps(counts, ensure_ascii=False))


if __name__ == "__main__":
    main()