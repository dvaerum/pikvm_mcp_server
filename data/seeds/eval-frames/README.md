# Held-out eval-gate frames (SEED — irreplaceable)

Real captured iPad frames used as the detector's ground-truth accept/reject gate
(train-crop-heatmap.py GATE, scratch/heatmap-gate.ts, cascade-eval.ts). Captured live;
NOT regenerable. Kept here as the durable seed copy (the scripts still reference the
scratch/ copies — repoint them here when convenient).
- hc13/15/17/18.jpg — home screen, NO cursor (REJECT: Books icon, Maps widget/app-icon, map terrain).
- clean-cursor.jpg — cursor on blue wallpaper (ACCEPT).
- MISS-t5-Settings-...PRE.jpg — cursor on the orange Books icon (ACCEPT; v13 missed it).
- MISS-t10-Books-...rnull.jpg — cursor on the Maps app icon (ACCEPT).
