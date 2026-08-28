from pathlib import Path

import pytest

from harmonia_agent.production_media import (
    CompositionCompileError,
    apply_voiceover_carve,
    compile_hyperframes_composition,
    inspect_media,
    render_hyperframes_composition,
)


def test_compiler_emits_deterministic_hyperframes_timeline_and_grouped_voice_carve(tmp_path: Path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "shot.mp4").write_bytes(b"video")
    (assets / "music.mp3").write_bytes(b"music")
    (assets / "voice.wav").write_bytes(b"voice")
    plan = {
        "id": "plan-1", "durationSec": 10, "width": 1080, "height": 1920,
        "scenes": [{"id": "scene-1", "startSec": 0, "durationSec": 10, "videoPath": "assets/shot.mp4", "title": "Launch <now>"}],
        "music": {"path": "assets/music.mp3", "volume": 0.8},
        "narration": [{"id": "voice-1", "path": "assets/voice.wav", "startSec": 1, "durationSec": 6}],
    }
    manifest = compile_hyperframes_composition(plan, tmp_path)
    html = (tmp_path / "index.html").read_text()
    assert 'data-composition-id="harmonia-plan-1"' in html
    assert 'data-start="0" data-width="1080" data-height="1920" data-duration="10"' in html
    assert 'data-audio-group="voiceover"' in html
    assert 'data-fx-carve=' in html and '&quot;voiceover&quot;' in html
    assert "Launch &lt;now&gt;" in html
    assert manifest["inputs"] == ["assets/music.mp3", "assets/shot.mp4", "assets/voice.wav"]
    assert manifest["voiceoverCarve"]["sources"] == ["voiceover"]


def test_compiler_rejects_paths_outside_its_workspace(tmp_path: Path):
    with pytest.raises(CompositionCompileError, match="workspace"):
        compile_hyperframes_composition({
            "id": "plan-1", "durationSec": 4, "width": 1080, "height": 1920,
            "scenes": [{"id": "scene-1", "startSec": 0, "durationSec": 4, "videoPath": "../secret.mp4"}],
            "narration": [],
        }, tmp_path)


def test_ffprobe_inspection_reads_real_stream_metadata(tmp_path: Path):
    # This is a real deterministic media check, not a simulated provider output.
    import subprocess

    output = tmp_path / "sample.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24:d=1",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(output),
    ], check=True)
    result = inspect_media(output)
    assert result["durationSec"] == pytest.approx(1, abs=0.1)
    assert result["video"] == {"codec": "h264", "width": 320, "height": 240, "frameRate": 24.0}
    assert result["audio"]["sampleRate"] == 48000
    assert result["sha256"] and len(result["sha256"]) == 64


def test_renderer_checks_before_high_quality_render_without_a_shell(tmp_path: Path):
    (tmp_path / "index.html").write_text("<html></html>")
    vendor_source = tmp_path / "source-gsap.js"
    vendor_source.write_text("window.gsap={};")
    command_log = tmp_path / "commands.txt"
    fake = tmp_path / "fake-hyperframes"
    fake.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$*\" >> '{command_log}'\n"
        "if [ \"$1\" = render ]; then while [ $# -gt 0 ]; do "
        "if [ \"$1\" = --output ]; then shift; printf video > \"$1\"; fi; shift; done; fi\n"
    )
    fake.chmod(0o755)
    output = render_hyperframes_composition(
        tmp_path, tmp_path / "out.mp4", executable=str(fake), gsap_source=vendor_source,
    )
    assert output.read_bytes() == b"video"
    assert command_log.read_text().splitlines() == [
        "check --strict", "render --quality high --output " + str(output),
    ]
    assert (tmp_path / "vendor" / "gsap.min.js").read_text() == "window.gsap={};"


def test_voiceover_carve_runs_analysis_and_requires_render_attributes(tmp_path: Path):
    (tmp_path / "index.html").write_text(
        '<audio id="music" data-fx-carve="{}"></audio>', encoding="utf-8"
    )
    fake = tmp_path / "fake-node"
    fake.write_text(
        "#!/bin/sh\n"
        "python3 -c 'from pathlib import Path; p=Path(\"index.html\"); s=p.read_text(); "
        "p.write_text(s.replace(\" data-fx-carve=\\\"{}\\\"\", "
        "\" data-fx-carve=\\\"{}\\\" data-fx-chain=\\\"{}\\\" data-automation=\\\"{}\\\"\"))'\n"
    )
    fake.chmod(0o755)
    script = tmp_path / "carve.mjs"
    script.write_text("// test")

    result = apply_voiceover_carve(
        tmp_path, executable=str(fake), script=script, core_dir=tmp_path
    )

    assert result["applied"] is True
    assert "data-fx-chain=" in (tmp_path / "index.html").read_text()
    assert "data-automation=" in (tmp_path / "index.html").read_text()
