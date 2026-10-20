#!/usr/bin/env python3
"""Gera index.html (enciclopédia de mídias do Drive) a partir de inventario.json.

Uso: python3 docs/enciclopedia-midias/gerar.py
"""
import json
from pathlib import Path

AQUI = Path(__file__).resolve().parent
dados = json.loads((AQUI / "inventario.json").read_text(encoding="utf-8"))
template = (AQUI / "template.html").read_text(encoding="utf-8")
# "</" escapado para que nenhum nome de arquivo feche a tag <script> por acidente
payload = json.dumps(dados, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
(AQUI / "index.html").write_text(template.replace("__DADOS__", payload), encoding="utf-8")
print(f"index.html gerado com {len(dados['arquivos'])} arquivos")
