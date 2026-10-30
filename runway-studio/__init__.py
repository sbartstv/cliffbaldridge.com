"""Runway Studio: serves the front-end app at /studio/ from inside ComfyUI.

No nodes are added. Serving from ComfyUI's own origin means the page can talk to
/api/prompt, /api/view and the websocket without any CORS setup.
"""
import os

from aiohttp import web
import server

ROOT = os.path.dirname(os.path.abspath(__file__))
# The plugin folder is also the website folder, so /studio/ and the hosted page serve the same files.
DOCS_DIR = ROOT
ASSET_DIR = os.path.join(ROOT, "assets")
WORKFLOW_DIR = os.path.join(ROOT, "workflows")

routes = server.PromptServer.instance.routes


@routes.get("/studio")
async def studio_redirect(request):
    raise web.HTTPFound("/studio/")


@routes.get("/studio/")
async def studio_index(request):
    return web.FileResponse(os.path.join(DOCS_DIR, "index.html"), headers={"Cache-Control": "no-store"})


@routes.get("/studio/workflows/{name}")
async def studio_workflow(request):
    name = os.path.basename(request.match_info["name"])
    path = os.path.join(WORKFLOW_DIR, name)
    if not name.endswith(".json") or not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "no-store"})


@routes.get("/studio/assets/{name}")
async def studio_asset(request):
    name = os.path.basename(request.match_info["name"])
    path = os.path.join(ASSET_DIR, name)
    if not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "no-store"})


@routes.get("/studio/media/{name}")
async def studio_media(request):
    name = os.path.basename(request.match_info["name"])
    path = os.path.join(ROOT, "media", name)
    if not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(path)


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
print("[Runway Studio] open http://127.0.0.1:8188/studio/")
