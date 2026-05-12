# -*- mode: python ; coding: utf-8 -*-

import os

from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.building.datastruct import Tree


hiddenimports = []
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("selenium")


tree_data = Tree("defaults", prefix="defaults")
optional_config_files = [
    ("config/runtime_config.json", "config"),
]
datas = [(src, dest) for src, dest in optional_config_files if os.path.exists(src)]
datas += [(src, dest) for dest, src, _ in tree_data]

a = Analysis(
    ["packaged_backend.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports + [
        "dotenv",
        "services.form_filler",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
