import {
  cargoCapacity,
  type Expedition,
  type Mineral,
  minerals,
  oxygenCapacity,
} from './Expedition';
import { SurveyMap } from './SurveyMap';
import './HuntHUD.css';

export class HuntHUD {
  private readonly root = document.createElement('section');
  readonly map: SurveyMap;
  readonly action: HTMLButtonElement;
  private readonly field: HTMLElement;
  private readonly station: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly oxygen: HTMLMeterElement;
  private readonly oxygenTime: HTMLElement;
  private readonly mapButton: HTMLButtonElement;
  private readonly prompt: HTMLElement;
  requested = false;

  constructor(height: (x: number, z: number) => number) {
    this.map = new SurveyMap(height);
    this.root.className = 'hunt-hud';
    this.root.setAttribute('aria-label', 'Lunar treasure hunt');
    this.root.innerHTML = `<section class="hunt-field">
      <button class="hunt-chart" type="button" aria-label="Enlarge survey map" aria-expanded="false"></button>
      <div class="hunt-panel"><div class="hunt-title">Surface survey</div>
      <div class="hunt-air"><span>Oxygen</span><b></b></div><meter aria-label="Oxygen remaining" min="0" max="180" low="45" high="90" optimum="180"></meter>
      <div class="hunt-cargo"></div><div class="hunt-guidance"></div>
      <button class="hunt-action" type="button"></button></div></section>
      <section class="hunt-station"><div class="hunt-title">Lunar base</div><h2>Sample vault</h2>
      <p class="hunt-report"></p><ul></ul><button class="hunt-launch" type="button">Depart in rover</button></section>`;
    const el = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s) as T;
    this.field = el('.hunt-field');
    this.station = el('.hunt-station');
    this.readout = el('.hunt-cargo');
    this.oxygen = el('meter');
    this.oxygenTime = el('.hunt-air b');
    this.prompt = el('.hunt-guidance');
    this.action = el('.hunt-action');
    this.mapButton = el('.hunt-chart');
    this.mapButton.append(this.map.canvas);
    this.mapButton.onclick = () => this.toggleMap();
    this.action.onclick = el('.hunt-launch').onclick = () => {
      this.requested = true;
    };
    document.body.append(this.root);
  }
  toggleMap() {
    const large = this.field.classList.toggle('expanded');
    this.mapButton.setAttribute('aria-expanded', String(large));
    this.mapButton.setAttribute('aria-label', large ? 'Reduce survey map' : 'Enlarge survey map');
  }

  showBase(mission: Expedition) {
    this.station.hidden = false;
    this.field.hidden = true;
    const report = this.station.querySelector('p');
    if (report) report.textContent = mission.report;
    const rows = (Object.keys(minerals) as Mineral[]).map((key) => {
      const item = document.createElement('li');
      const gem = document.createElement('i');
      gem.style.color = minerals[key].color;
      const count = document.createElement('b');
      count.textContent = String(mission.collection[key]);
      item.append(gem, minerals[key].name, count);
      return item;
    });
    this.station.querySelector('ul')?.replaceChildren(...rows);
  }

  showField() {
    this.station.hidden = true;
    this.field.hidden = false;
  }
  update(mission: Expedition, guidance: string, action: string) {
    const seconds = Math.ceil(mission.oxygen);
    this.oxygen.max = oxygenCapacity;
    this.oxygen.value = seconds;
    this.oxygenTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    this.field.classList.toggle('low-air', seconds <= 45);
    this.readout.textContent = `Rover cargo  ${mission.cargo.length}/${cargoCapacity}${mission.hand ? `  ·  Carrying ${minerals[mission.hand.mineral].name}` : ''}`;
    this.prompt.textContent = guidance;
    this.action.textContent = `${action} [E]`;
    this.action.hidden = !action;
  }
  dispose() {
    this.root.remove();
  }
}
