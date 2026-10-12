// Design rule check (docs/DESIGN.md). Pages that have moved to assets/hada-ui.css may only use its
// tokens: no raw colors, and font sizes, spacing, radii and widths come from var(--...).
// Run: node tests/design-lint.cjs   (no dependencies)
const fs=require('fs');
// Pages converted to the shared tokens. Add a page here when it moves to assets/hada-ui.css.
const PAGES=['admin_settings.html','attendance_kiosk.html'];
const SHARED='assets/hada-ui.css';
const errors=[];
function cssOf(file){
  const text=fs.readFileSync(file,'utf8');
  if(file.endsWith('.css'))return [{css:text,offset:0,text}];
  return [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m=>({css:m[1],offset:m.index+7,text}));
}
const lineOf=(text,index)=>text.slice(0,index).split('\n').length;
const SPACE_PROPS=/^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block))?$/;
const allowedLength=v=>/^(0|auto|-?[0-3]px|-?\d*\.?\d+(%|em)|var\(--[a-z0-9-]+\)|calc\(.*var\(--.*\)\))$/.test(v);
function check(file){
  for(const {css,offset,text} of cssOf(file)){
    // Token definitions live only in the shared :root blocks.
    const body=file===SHARED?css.replace(/:root\{[^}]*\}/g,m=>' '.repeat(m.length)):css;
    const clean=body.replace(/\/\*[\s\S]*?\*\//g,m=>' '.repeat(m.length));
    for(const block of clean.matchAll(/\{([^{}]*)\}/g)){
      let at=block.index+1;
      for(const decl of block[1].split(';')){
        const m=decl.match(/^\s*([a-z-]+)\s*:\s*([\s\S]+?)\s*$/);const where=`${file}:${lineOf(text,offset+at)}`;at+=decl.length+1;
        if(!m)continue;
        // Pages may define their own layout variables, but never colors (colors are shared tokens only).
        if(m[1].startsWith('--')){if(file!==SHARED&&/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i.test(m[2]))errors.push(`${where} ${m[1]}: 화면에서 색 변수를 새로 만들지 않습니다`);continue;}
        const [,prop,value]=m;const v=value.replace(/!important$/,'').trim();
        if(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black)\b/i.test(v))errors.push(`${where} ${prop}: 색은 토큰(var(--...))만 씁니다 → ${v}`);
        if(prop==='font-size'&&!/^(var\(--(text-[a-z]+|device-font)\)|inherit|\d*\.?\d+em)$/.test(v))errors.push(`${where} font-size: --text-* 토큰을 씁니다 → ${v}`);
        if(SPACE_PROPS.test(prop)&&!v.split(/\s+(?![^(]*\))/).every(allowedLength))errors.push(`${where} ${prop}: 간격은 --space-* 토큰(0~3px 선은 허용) → ${v}`);
        if(prop==='border-radius'&&!/^(0|50%|var\(--radius-[a-z]+\))$/.test(v))errors.push(`${where} border-radius: --radius-* 토큰을 씁니다 → ${v}`);
        if(/^(max-)?width$/.test(prop)&&/^\d+px$/.test(v)&&parseInt(v)>48)errors.push(`${where} ${prop}: 레이아웃 폭은 토큰(--page-max, --form-max 등)을 씁니다 → ${v}`);
        if(prop==='font-family'&&!/^var\(--font-(sans|mono)\)$|^inherit$/.test(v))errors.push(`${where} font-family: --font-sans/--font-mono만 씁니다 → ${v}`);
      }
    }
  }
}
for(const file of [SHARED,...PAGES])check(file);
for(const page of PAGES){
  const html=fs.readFileSync(page,'utf8');
  if(!html.includes('href="assets/hada-ui.css"'))errors.push(`${page}: assets/hada-ui.css를 불러오지 않습니다`);
  if(/\sstyle="/.test(html))errors.push(`${page}: 인라인 style 속성 대신 클래스를 씁니다`);
}
if(errors.length){console.error(errors.join('\n'));console.error(`디자인 규칙 위반 ${errors.length}건`);process.exit(1);}
console.log(`디자인 규칙 검사 통과: ${[SHARED,...PAGES].join(', ')}`);
