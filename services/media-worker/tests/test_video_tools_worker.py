import json
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from app.main import (
    AnalyzeRequest,
    EditPlanRequest,
    EditPlanSegment,
    TextOverlayItem,
    VideoAnalysisResult,
    analyze_video,
    render_edit_plan,
)


class TestVideoToolsMediaWorker(unittest.TestCase):
    def test_analyze_video_extracts_tempo_and_scene_cuts(self):
        req = AnalyzeRequest(videoPath="/uploads/sample.mp4")

        # probe のモック (ffprobe)
        probe_json = {
            "format": {"duration": "15.0"},
            "streams": [
                {
                    "codec_type": "video",
                    "width": 1080,
                    "height": 1920,
                    "avg_frame_rate": "30/1",
                    "codec_name": "h264",
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                },
            ],
        }

        # scene detection stderr のモック (FFmpeg showinfo)
        scene_stderr = (
            "pts_time:3.200 pos:1000\n"
            "pts_time:7.500 pos:2000\n"
            "pts_time:12.100 pos:3000\n"
        )

        with patch("pathlib.Path.is_file", return_value=True), \
             patch("pathlib.Path.exists", return_value=True), \
             patch("app.main.subprocess.run") as mock_run:
            # 1回目は ffprobe, 2回目は ffmpeg scene filter
            mock_run.side_effect = [
                CompletedProcess(["ffprobe"], 0, stdout=json.dumps(probe_json), stderr=""),
                CompletedProcess(["ffmpeg"], 0, stdout="", stderr=scene_stderr),
            ]

            result = analyze_video(req)

            self.assertIsInstance(result, VideoAnalysisResult)
            self.assertEqual(result.width, 1080)
            self.assertEqual(result.height, 1920)
            self.assertEqual(result.aspectRatio, "9:16")
            self.assertEqual(result.orientation, "vertical")
            self.assertAlmostEqual(result.durationSeconds, 15.0)
            self.assertEqual(result.sceneCount, 4)  # 3 cuts -> 4 scenes
            self.assertEqual(len(result.sceneCuts), 3)
            self.assertAlmostEqual(result.sceneCuts[0], 3.2)
            self.assertAlmostEqual(result.sceneCuts[1], 7.5)
            self.assertAlmostEqual(result.sceneCuts[2], 12.1)
            # 15.0 / 4 = 3.75s -> MEDIUM tempo
            self.assertEqual(result.tempo, "MEDIUM")
            self.assertTrue(result.isBgmEstimated)
            self.assertTrue(result.isSubtitlesEstimated)

    def test_render_edit_plan_builds_ffmpeg_filtergraph(self):
        req = EditPlanRequest(
            sourceVideoPath="/uploads/source.mp4",
            targetAspectRatio="9:16",
            segments=[
                EditPlanSegment(
                    sourcePath="/uploads/source.mp4",
                    startSeconds=0.0,
                    endSeconds=3.0,
                    playbackSpeed=1.0,
                    textOverlay=TextOverlayItem(text="Scene 1", x=0.5, y=0.8, fontSize=48),
                ),
                EditPlanSegment(
                    sourcePath="/uploads/source.mp4",
                    startSeconds=5.0,
                    endSeconds=9.0,
                    playbackSpeed=1.2,
                ),
            ],
            bgmPath="/uploads/bgm.mp3",
            bgmVolume=0.2,
        )

        with patch("pathlib.Path.is_file", return_value=True), \
             patch("pathlib.Path.exists", return_value=True), \
             patch("pathlib.Path.stat") as mock_stat, \
             patch("app.main.subprocess.run") as mock_run:
            mock_stat.return_value.st_size = 1024 * 1024
            mock_run.return_value = CompletedProcess(["ffmpeg"], 0, stdout="", stderr="")

            res = render_edit_plan(req)

            self.assertIn("targetPath", res)
            self.assertTrue(res["targetPath"].endswith(".mp4"))
            self.assertTrue(mock_run.called)
            # コマンド引数に ffmpeg と filter_complex が含まれていること
            cmd = mock_run.call_args[0][0]
            self.assertEqual(cmd[0], "ffmpeg")
            self.assertIn("-filter_complex", cmd)


if __name__ == "__main__":
    unittest.main()
