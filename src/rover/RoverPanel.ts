import { CanvasTexture, Mesh, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace } from 'three';

// Printed aluminium faceplate. The needle and mechanical readouts are linked
// to the simulated traverse; the static dial work is painted only once.
export class RoverPanel {
  readonly mesh: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly face = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private lastReading = '';

  constructor() {
    this.canvas.width = this.face.width = 768;
    this.canvas.height = this.face.height = 440;
    const ctx = this.canvas.getContext('2d');
    const plate = this.face.getContext('2d');
    if (!ctx || !plate) throw new Error('Rover panel needs a 2D canvas');
    this.ctx = ctx;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new Mesh(
      new PlaneGeometry(0.441, 0.25),
      new MeshStandardMaterial({
        map: this.texture,
        metalness: 0.18,
        roughness: 0.66,
      })
    );
    this.mesh.position.set(0, 0.71, -0.477);
    this.mesh.rotation.x = -0.23;
    plate.fillStyle = '#b4b3a9';
    plate.fillRect(0, 0, 768, 440);
    plate.textAlign = 'center';
    plate.fillStyle = '#222421';
    plate.font = 'bold 19px sans-serif';
    plate.fillText('LUNAR ROVING VEHICLE', 384, 29);
    plate.strokeStyle = '#474741';
    plate.strokeRect(19, 42, 730, 372);
    for (const [x, label] of [
      [156, 'VELOCITY'],
      [389, 'HEADING'],
      [614, 'DISTANCE'],
    ] as const) {
      plate.fillStyle = '#222421';
      plate.font = 'bold 17px sans-serif';
      plate.fillText(label, x, 71);
      plate.fillStyle = '#7f807a';
      plate.fillRect(x - 100, 84, 200, 181);
      plate.fillStyle = '#222524';
      plate.fillRect(x - 94, 89, 188, 170);
    }
    const cx = 156,
      cy = 174,
      r = 72;
    plate.fillStyle = '#0f1212';
    plate.beginPath();
    plate.arc(cx, cy, r, 0, 2 * Math.PI);
    plate.fill();
    for (let i = 0; i <= 20; i++) {
      const angle = ((145 + i * 12.5) * Math.PI) / 180,
        c = Math.cos(angle),
        s = Math.sin(angle);
      const inner = i % 5 === 0 ? 52 : 60;
      plate.strokeStyle = '#ebe7d8';
      plate.lineWidth = i % 5 === 0 ? 3 : 1.4;
      plate.beginPath();
      plate.moveTo(cx + inner * c, cy + inner * s);
      plate.lineTo(cx + 66 * c, cy + 66 * s);
      plate.stroke();
      if (i % 5 === 0) {
        plate.fillStyle = '#f1ecdf';
        plate.font = '12px sans-serif';
        plate.fillText(String(i), cx + 40 * c, cy + 40 * s + 4);
      }
    }
    plate.fillStyle = '#ebe7dd';
    plate.font = '11px sans-serif';
    plate.fillText('KM/H', cx, 214);
    plate.font = '14px sans-serif';
    plate.fillText('DEGREES', 389, 228);
    plate.fillText('METRES', 614, 228);
    const labels = ['NAV RESET', 'GYRO', 'FRONT', 'REAR', 'DRIVE', 'STEER', 'POWER'];
    for (let i = 0; i < labels.length; i++) {
      const x = 77 + i * 101;
      plate.fillStyle = '#24251f';
      plate.font = 'bold 13px sans-serif';
      plate.fillText(labels[i], x, 301);
      plate.fillStyle = '#686b63';
      plate.fillRect(x - 23, 312, 46, 68);
      plate.fillStyle = '#2b2e29';
      plate.fillRect(x - 15, 321, 30, 50);
      plate.fillStyle = i === 6 ? '#c67954' : '#e0ded1';
      plate.fillRect(x - 7, 325, 14, 28);
    }
    for (const x of [11, 757])
      for (const y of [11, 428]) {
        plate.fillStyle = '#52554f';
        plate.beginPath();
        plate.arc(x, y, 6, 0, 7);
        plate.fill();
        plate.strokeStyle = '#c9c9bc';
        plate.beginPath();
        plate.moveTo(x - 3, y + 2);
        plate.lineTo(x + 3, y - 2);
        plate.stroke();
      }
    this.update(0, 0, 0);
  }

  update(speed: number, bearing: number, trip: number) {
    const kmh = Math.round(Math.abs(speed) * 36) / 10;
    const heading = (Math.round(bearing) + 360) % 360;
    const meters = Math.round(trip);
    const key = `${kmh}/${heading}/${meters}`;
    if (key === this.lastReading) return;
    this.lastReading = key;
    const c = this.ctx;
    c.drawImage(this.face, 0, 0);
    const angle = ((145 + 12.5 * Math.min(20, kmh)) * Math.PI) / 180;
    c.strokeStyle = '#f4a369';
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(156, 174);
    c.lineTo(156 + 54 * Math.cos(angle), 174 + 54 * Math.sin(angle));
    c.stroke();
    c.fillStyle = '#e2dfc9';
    c.textAlign = 'center';
    c.font = 'bold 42px monospace';
    c.fillText(String(heading).padStart(3, '0'), 389, 188);
    c.fillText(String(meters).padStart(4, '0'), 614, 188);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    this.mesh.material.dispose();
  }
}
