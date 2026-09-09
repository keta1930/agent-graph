import json
import os
import zipfile
from pathlib import Path

from pymongo import MongoClient


def verify():
    artifacts = Path(os.environ["E2E_ARTIFACT_DIR"])
    plain = json.loads((artifacts / "plain-conversation.json").read_text())
    with MongoClient(os.environ["MONGODB_URL"]) as client:
        database = client[os.environ["MONGODB_DB"]]
        metadata = database.conversations.find_one({"_id": plain["id"]})
        rounds = database.agent_run.find_one({"conversation_id": plain["id"]})
        assert metadata and metadata["user_id"] == os.environ["ADMIN_USERNAME"]
        assert rounds and all(marker in json.dumps(rounds, default=str) for marker in plain["markers"])
        assert all(not item.get("tools") for item in rounds["rounds"])
    wires = [file.read_text() for file in (artifacts / "wire").glob("*.sse")]
    plain_wires = [wire for wire in wires if "E2E_PLAIN_" in wire]
    assert len(plain_wires) == 2
    assert all('"tool_calls": null' in wire and wire.count("data: [DONE]") == 1 for wire in plain_wires)
    assert any('"function": null' in wire and '"tool_call_id": "call_e2e_add"' in wire for wire in wires)
    requests = [json.loads(line) for line in (artifacts / "model-requests.jsonl").read_text().splitlines()]
    assert all(not row["tool_names"] for row in requests if "E2E_PLAIN_" in row["prompt"])
    shared = json.loads((artifacts / "share-verification.json").read_text())
    for archive_name in ["public-share.zip", "authenticated-files.zip"]:
        with zipfile.ZipFile(artifacts / archive_name) as archive:
            assert sorted(archive.namelist()) == sorted(shared["expectedFiles"])
            for name, content in shared["expectedFiles"].items():
                assert archive.read(name) == content.encode("utf-8")
    assert not list(Path(os.environ["TMPDIR"]).rglob("*.zip")), "Application ZIP remains in its isolated temporary directory"
    (artifacts / "database-wire-verification.json").write_text(json.dumps({
        "mongo_owner_matched": True, "mongo_plain_rounds": len(rounds["rounds"]),
        "plain_tools_empty": True, "plain_wire_done_once": True,
        "tool_function_null_and_actual_result": True,
        "share_zip_members_and_bytes_match": True, "no_temporary_zip_remains": True,
        "wire_count": len(wires), "upstream_requests": len(requests),
    }, indent=2) + "\n")


if __name__ == "__main__":
    verify()
