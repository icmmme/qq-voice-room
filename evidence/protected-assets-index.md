# Protected Assets Index — M1

This index records the protected-asset manifest used by M1. It does not copy
P content, history or private memory into Q.

- Manifest: `Shared/vr-audit-01-closure-20261115/ASSET_MANIFEST_FINAL.json`
- SHA256: `D45E84EC6B4DFABEBA45634C0DFF7E141C8CB24D66D4B02D941C8B0AEAAE964A`
- Groups: P=8, M=15, D=71, H=10; total=104

## P protected assets (8)

| Path | Bytes | SHA256 |
| --- | ---: | --- |
| `src/voice-room/participation-planner.ts` | 7056 | `3E9BB8375CC29EEB8EDD8753C0653DC6BDD1AD8AB3668B75BC2C4252082331C4` |
| `.harness/CURRENT_TASK.md` | 16240 | `85F20673A2FF96A0877658599848C73BD28A2F7FBB1175D82FA9919F316C0851` |
| `.harness/PROJECT_STATE.md` | 54276 | `E10A5321926B69E966E4A92B11D40B714853D508A32A17B7E45501D392D8DA75` |
| `docs/operations/VOICE_ROOM_SETUP.md` | 12503 | `3D3308E76C3E732607D7B75CDE989E3941AD70786E04C441C1F182B134D1C97E` |
| `docs/product/DECISIONS.md` | 22044 | `DAA97852E3F1CF755A42283EAFD397C682018416C37CB58BFF9D10ACA6EDC27D` |
| `docs/product/IMPLEMENTATION_SPEC.md` | 18884 | `314DF4F4A6A0C5E99FA2AE887D5F2A6CB4455DCD85612F6C9EF533CD59342EEE` |
| `docs/product/PRD.md` | 28379 | `D6FA76702E21250321BA94059BC5014E379908050F0BA8AB97E1233C33508F0F` |
| `src/voice-room/store.ts` | 202592 | `F6C5CC4D088E5309B420CAD7F6D98F7AF3AA8313F6929A4332151F9BC9EB21DE` |

## Treatment

- P is read-only in M1.
- No P history, private memory or protected asset is copied into Q.
- The three inherited Q Web files are legacy assets, not `VR-EXT-WEB-001`
  evidence: `src/voice-room/websearch.ts`, `src/web.ts`, `src/web-task.ts`.
