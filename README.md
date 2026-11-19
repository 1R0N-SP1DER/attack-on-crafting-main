# Attack on Crafting

Attack on Titan add-on for the latest Minecraft Bedrock.

Layout
- models/  drop raw Blockbench .bbmodel files, particles and animation json here
- RP/      resource pack (generated assets land here, entity client files go here)
- BP/      behavior pack (entities, items, scripts)
- tools/export_bbmodels.py  converts models/ into RP/ (geometry, animations, textures)
- tools/validate.py         checks manifests, JSON, geometry and animation ids

Workflow
1. Put new model files in models/
2. python3 tools/export_bbmodels.py
3. python3 tools/validate.py
4. Open a pull request; GitHub runs the same checks
