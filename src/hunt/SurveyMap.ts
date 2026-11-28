import type { DigSite } from '../terrain/Excavations';
import type { Expedition } from './Expedition';

/** North (-Z) stays at the top. Relief, sites, and actors use the same metre grid. */
export class SurveyMap {
  readonly canvas = document.createElement('canvas');
  private readonly relief = document.createElement('canvas');
  private originX = Infinity;
  private originZ = Infinity;
  constructor(private readonly height: (x: number, z: number) => number) {
    this.canvas.width = this.canvas.height = 320;
    this.canvas.setAttribute('aria-label', 'North-up lunar terrain and survey signals');
    this.relief.width = this.relief.height = 128;
  }

  private shade(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    const ctx = this.relief.getContext('2d');
    if (!ctx) return;
    const n = this.relief.width;
    const layer = ctx.createImageData(n, n);
    const heights = new Float32Array((n + 1) ** 2);
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) heights[j * (n + 1) + i] = this.height(x + i * 2, z + j * 2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * (n + 1) + i,
          h = heights[k];
        const east = heights[k + 1],
          south = heights[k + n + 1];
        const contour =
          Math.floor(h / 2) !== Math.floor(east / 2) || Math.floor(h / 2) !== Math.floor(south / 2);
        const value = Math.max(
          24,
          Math.min(137, 67 + (east + south - 2 * h) * 65 - (contour ? 13 : 0))
        );
        layer.data.set([value * 0.78, value * 0.96, value, 255], (j * n + i) * 4);
      }
    }
    ctx.putImageData(layer, 0, 0);
  }

  draw(mission: Expedition, player: DigSite, rover: DigSite, bearing: number) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    // Cache a 256 m relief tile around a 160 m window; scrolling only blits it.
    if (
      Math.abs(player.x - this.originX - 128) > 45 ||
      Math.abs(player.z - this.originZ - 128) > 45
    )
      this.shade(Math.round(player.x / 32) * 32 - 128, Math.round(player.z / 32) * 32 - 128);
    const pixelsPerMetre = mission.phase === 'eva' ? 8 : 2;
    const gridMetres = 40 / pixelsPerMetre;
    const sx = (x: number) => 160 + (x - player.x) * pixelsPerMetre;
    const sz = (z: number) => 160 + (z - player.z) * pixelsPerMetre;
    ctx.drawImage(
      this.relief,
      sx(this.originX),
      sz(this.originZ),
      256 * pixelsPerMetre,
      256 * pixelsPerMetre
    );
    ctx.strokeStyle = '#c7e6d62b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -4; i <= 4; i++) {
      const x = sx((Math.round(player.x / gridMetres) + i) * gridMetres);
      const z = sz((Math.round(player.z / gridMetres) + i) * gridMetres);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 320);
      ctx.moveTo(0, z);
      ctx.lineTo(320, z);
    }
    ctx.stroke();
    const mark = (point: DigSite, color: string, label: string) => {
      const dx = sx(point.x) - 160,
        dz = sz(point.z) - 160;
      const scale = Math.min(1, 145 / Math.max(1, Math.abs(dx), Math.abs(dz)));
      const x = 160 + dx * scale,
        z = 160 + dz * scale;
      ctx.fillStyle = '#102228';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, z, scale < 1 ? 8 : 10, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      ctx.fillText(label, x, z + 5);
    };
    mission.sites.forEach((site, i) => {
      if (site.location === 'ground') mark(site, '#ffd294', String(i + 1));
    });
    mark(mission.base, '#9bead6', 'B');
    if (mission.phase === 'eva') mark(rover, '#fff', 'R');
    ctx.save();
    ctx.translate(160, 160);
    ctx.rotate(bearing);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#172429';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 5);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.font = 'bold 16px monospace';
    ctx.fillText('N ↑', 10, 22);
    ctx.fillRect(10, 305, 40, 2);
    ctx.font = '13px monospace';
    ctx.fillText(`${gridMetres} m`, 10, 300);
  }
}
