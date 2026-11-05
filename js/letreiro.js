// Letreiro de neon: o arco do "A" do logo, 6 tubos que acendem de fora para dentro.
// Usado no cardápio (index.html) e na página O Rainbow (sobre/).
export const CORES_ARCO = ['#E5484D', '#F2892B', '#F5CB3B', '#3DBE6A', '#3B82E0', '#9157E0'];
const calmo = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function desenharArco(svg, cores = CORES_ARCO) {
  const cx = 50, base = 110, topo = 50, passo = 8.2;
  let html = '';
  cores.forEach((c, i) => {
    const r = 45 - i * passo;
    const d = `M ${cx - r} ${base} V ${topo} A ${r} ${r} 0 0 1 ${cx + r} ${topo} V ${base}`;
    html += `<g class="tubo" style="--c:${c}">
      <path class="tubo__vidro" d="${d}" stroke="${c}"/>
      <path class="tubo__luz" d="${d}" stroke="${c}"/>
      <path class="tubo__miolo" d="${d}"/>
    </g>`;
  });
  html += `<rect class="presilha" x="2.5" y="88" width="5" height="8" rx="1.2"/>
    <rect class="presilha" x="92.5" y="88" width="5" height="8" rx="1.2"/>
    <rect class="presilha" x="46" y="2.5" width="8" height="5" rx="1.2"/>`;
  svg.innerHTML = html;
}

export function acender(topo, depois = []) {
  const tubos = [...topo.querySelectorAll('.tubo')];
  depois.forEach((el) => el && el.classList.add('depois'));
  if (calmo) {
    tubos.forEach((t) => t.classList.add('aceso'));
    topo.classList.add('pintado', 'ligado', 'pub-aceso', 'mostrar');
    return;
  }
  requestAnimationFrame(() => topo.classList.add('pintado'));
  tubos.forEach((t, i) => setTimeout(() => {
    t.classList.add('aceso', 'acendendo');
    if (i === 0) topo.classList.add('ligado');
  }, 400 + i * 170));
  const fim = 400 + tubos.length * 170;
  setTimeout(() => topo.classList.add('pub-aceso'), fim + 120);
  setTimeout(() => topo.classList.add('mostrar'), fim + 380);

  // neon de verdade falha de vez em quando (só com o letreiro na tela)
  let visivel = true;
  new IntersectionObserver(([e]) => { visivel = e.isIntersecting; }).observe(topo);
  setInterval(() => {
    if (!visivel || document.hidden) return;
    const t = tubos[Math.floor(Math.random() * tubos.length)];
    t.classList.remove('acendendo', 'falhando');
    void t.getBBox();
    t.classList.add('falhando');
    setTimeout(() => t.classList.remove('falhando'), 600);
  }, 9000);
}
