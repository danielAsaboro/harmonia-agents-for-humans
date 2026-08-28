"""Deterministic composition compilation and real media inspection."""

from __future__ import annotations

import hashlib
import html
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any


class CompositionCompileError(ValueError):
    """A production plan cannot be compiled safely."""


class MediaInspectionError(RuntimeError):
    """ffprobe could not establish the integrity of a media artifact."""


def _number(value: Any, name: str, *, minimum: float = 0) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < minimum:
        raise CompositionCompileError(f"{name} must be a number >= {minimum}")
    return float(value)


def _media_path(workspace: Path, raw: Any) -> str:
    if not isinstance(raw, str) or not raw:
        raise CompositionCompileError("media path is required")
    root = workspace.resolve()
    resolved = (workspace / raw).resolve()
    if resolved != root and root not in resolved.parents:
        raise CompositionCompileError("media path must remain inside the composition workspace")
    if not resolved.is_file():
        raise CompositionCompileError(f"media path does not exist inside the workspace: {raw}")
    return resolved.relative_to(root).as_posix()


def _attr_json(value: Any) -> str:
    return html.escape(json.dumps(value, sort_keys=True, separators=(",", ":")), quote=True)


def compile_hyperframes_composition(plan: dict[str, Any], workspace: Path) -> dict[str, Any]:
    """Compile a constrained plan to standalone HyperFrames HTML and a manifest."""
    workspace.mkdir(parents=True, exist_ok=True)
    plan_id = str(plan.get("id") or "").strip()
    if not plan_id or not all(ch.isalnum() or ch in "-_" for ch in plan_id):
        raise CompositionCompileError("plan id must be filesystem and DOM safe")
    duration = _number(plan.get("durationSec"), "durationSec", minimum=0.01)
    width = int(_number(plan.get("width"), "width", minimum=1))
    height = int(_number(plan.get("height"), "height", minimum=1))
    scenes = plan.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise CompositionCompileError("at least one scene is required")

    inputs: set[str] = set()
    scene_markup: list[str] = []
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            raise CompositionCompileError("scene must be an object")
        scene_id = str(scene.get("id") or f"scene-{index + 1}")
        start = _number(scene.get("startSec"), "scene.startSec")
        scene_duration = _number(scene.get("durationSec"), "scene.durationSec", minimum=0.01)
        if start + scene_duration > duration + 0.001:
            raise CompositionCompileError("scene extends beyond composition duration")
        source = _media_path(workspace, scene.get("videoPath"))
        inputs.add(source)
        title = html.escape(str(scene.get("title") or ""))
        scene_markup.append(
            f'<video id="hf-{plan_id}-{scene_id}-video" class="clip" src="{html.escape(source, quote=True)}" '
            f'data-start="{start:g}" data-duration="{scene_duration:g}" data-track-index="{index}" muted playsinline></video>'
        )
        if title:
            scene_markup.append(
                f'<section id="hf-{plan_id}-{scene_id}-title" class="clip title" data-start="{start:g}" '
                f'data-duration="{scene_duration:g}" data-track-index="{100 + index}"><h2>{title}</h2></section>'
            )

    audio_markup: list[str] = []
    narration = plan.get("narration") or []
    if not isinstance(narration, list):
        raise CompositionCompileError("narration must be a list")
    for index, voice in enumerate(narration):
        source = _media_path(workspace, voice.get("path"))
        inputs.add(source)
        voice_id = str(voice.get("id") or f"voice-{index + 1}")
        start = _number(voice.get("startSec"), "narration.startSec")
        voice_duration = _number(voice.get("durationSec"), "narration.durationSec", minimum=0.01)
        audio_markup.append(
            f'<audio id="hf-{plan_id}-{voice_id}" src="{html.escape(source, quote=True)}" '
            f'data-start="{start:g}" data-duration="{voice_duration:g}" data-track-index="{200 + index}" '
            'data-audio-group="voiceover" data-volume="1"></audio>'
        )

    carve = None
    music = plan.get("music")
    if music is not None:
        if not isinstance(music, dict):
            raise CompositionCompileError("music must be an object")
        source = _media_path(workspace, music.get("path"))
        inputs.add(source)
        volume = _number(music.get("volume", 0.8), "music.volume")
        if volume > 1:
            raise CompositionCompileError("music.volume must be <= 1")
        carve = {"enabled": bool(narration), "sources": ["voiceover"] if narration else [], "strength": 0.25, "dynamic": True}
        carve_attribute = f' data-fx-carve="{_attr_json(carve)}"' if narration else ""
        audio_markup.append(
            f'<audio id="hf-{plan_id}-music" src="{html.escape(source, quote=True)}" data-start="0" '
            f'data-duration="{duration:g}" data-track-index="300" data-volume="{volume:g}"{carve_attribute}></audio>'
        )

    composition_id = f"harmonia-{plan_id}"
    index_html = f'''<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width={width}, height={height}">
<title>Harmonia production {html.escape(plan_id)}</title><script src="vendor/gsap.min.js"></script>
<style>html,body{{margin:0;width:{width}px;height:{height}px;background:#070b14;color:white;overflow:hidden}}#root{{position:relative;width:{width}px;height:{height}px;overflow:hidden}}.clip{{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}}.title{{display:grid;place-items:end start;padding:8%;box-sizing:border-box}}h2{{font:700 64px/1.05 Inter,system-ui,sans-serif;margin:0;max-width:80%}}</style></head>
<body><div id="root" data-composition-id="{composition_id}" data-start="0" data-width="{width}" data-height="{height}" data-duration="{duration:g}">
{''.join(scene_markup)}{''.join(audio_markup)}</div>
<script>window.__timelines=window.__timelines||{{}};const tl=gsap.timeline({{paused:true}});window.__timelines["{composition_id}"]=tl;</script></body></html>'''
    (workspace / "index.html").write_text(index_html, encoding="utf-8")
    manifest = {
        "schemaVersion": 1,
        "planId": plan_id,
        "compositionId": composition_id,
        "durationSec": duration,
        "dimensions": {"width": width, "height": height},
        "inputs": sorted(inputs),
        "voiceoverCarve": carve,
    }
    (workspace / "composition-manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    return manifest


def _rate(value: str) -> float:
    numerator, _, denominator = value.partition("/")
    return float(numerator) / float(denominator or 1)


def inspect_media(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size == 0:
        raise MediaInspectionError("media artifact is missing or empty")
    command = [
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration,size,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
        "-of", "json", str(path),
    ]
    try:
        completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
        raw = json.loads(completed.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise MediaInspectionError(f"ffprobe could not inspect media: {exc}") from exc
    streams = raw.get("streams") or []
    video_stream = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio_streams = [item for item in streams if item.get("codec_type") == "audio"]
    video = None if video_stream is None else {
        "codec": video_stream.get("codec_name"),
        "width": int(video_stream.get("width") or 0),
        "height": int(video_stream.get("height") or 0),
        "frameRate": _rate(str(video_stream.get("avg_frame_rate") or "0/1")),
    }
    audio = [{
        "codec": item.get("codec_name"),
        "sampleRate": int(item.get("sample_rate") or 0),
        "channels": int(item.get("channels") or 0),
    } for item in audio_streams]
    return {
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bytes": path.stat().st_size,
        "durationSec": float((raw.get("format") or {}).get("duration") or 0),
        "format": (raw.get("format") or {}).get("format_name"),
        "video": video,
        "audio": audio[0] if len(audio) == 1 else audio,
    }


def apply_voiceover_carve(
    workspace: Path,
    *,
    executable: str = "node",
    script: Path = Path("/opt/hyperframes/scripts/apply-carve.mjs"),
    core_dir: Path = Path("/opt/hyperframes"),
) -> dict[str, Any]:
    """Analyze grouped voices and persist the render-consumed carve attributes."""
    composition = workspace / "index.html"
    if not composition.is_file() or not script.is_file():
        raise CompositionCompileError("composition or pinned carve analyzer is unavailable")
    command = [executable, str(script), "--comp", str(composition), "--core", str(core_dir)]
    try:
        completed = subprocess.run(
            command, cwd=workspace, check=True, capture_output=True, text=True, timeout=300
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise MediaInspectionError("voiceover carve analysis failed") from exc
    rendered = composition.read_text(encoding="utf-8")
    if "data-fx-chain=" not in rendered or "data-automation=" not in rendered:
        raise MediaInspectionError("carve analysis did not produce renderable effects and automation")
    try:
        details = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        details = {"output": completed.stdout.strip()}
    receipt = {
        "applied": True,
        **details,
        "compositionSha256": hashlib.sha256(rendered.encode("utf-8")).hexdigest(),
    }
    manifest_path = workspace / "composition-manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["voiceoverCarveAnalysis"] = receipt
        manifest_path.write_text(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8"
        )
    return receipt


def render_hyperframes_composition(
    workspace: Path,
    output: Path,
    *,
    executable: str = "hyperframes",
    gsap_source: Path = Path("/opt/hyperframes/node_modules/gsap/dist/gsap.min.js"),
    carve_script: Path = Path("/opt/hyperframes/scripts/apply-carve.mjs"),
) -> Path:
    """Validate then render a compiled project with an argv-only subprocess boundary."""
    if not (workspace / "index.html").is_file():
        raise CompositionCompileError("compiled index.html is missing")
    if not gsap_source.is_file():
        raise CompositionCompileError("pinned GSAP runtime is unavailable")
    vendor = workspace / "vendor"
    vendor.mkdir(exist_ok=True)
    shutil.copyfile(gsap_source, vendor / "gsap.min.js")
    composition_html = (workspace / "index.html").read_text(encoding="utf-8")
    if "data-fx-carve=" in composition_html and "data-fx-chain=" not in composition_html:
        apply_voiceover_carve(workspace, script=carve_script)
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    commands = [
        [executable, "check", "--strict"],
        [executable, "render", "--quality", "high", "--output", str(output)],
    ]
    for command in commands:
        try:
            subprocess.run(command, cwd=workspace, check=True, timeout=900)
        except (OSError, subprocess.SubprocessError) as exc:
            raise MediaInspectionError(f"HyperFrames command failed: {command[1]}") from exc
    if not output.is_file() or output.stat().st_size == 0:
        raise MediaInspectionError("HyperFrames reported success without a rendered artifact")
    return output
