// Design rule check (docs/DESIGN.md). Pages that have moved to assets/hada-ui.css may only use its
// tokens: no raw colors, and font sizes, spacing, radii and widths come from var(--...).
// Run: node tests/design-lint.cjs   (no dependencies)
const fs=require('fs');
// Pages converted to the shared tokens. Add a page here when it moves to assets/hada-ui.css.
const PAGES=['admin_settings.html','attendance_kiosk.html','school_search.html','textbook_search.html','legal_documents.html','class_room.html'];
const SHARED='assets/hada-ui.css',TOKENS='assets/hada-tokens.css';
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
    const body=file===TOKENS?css.replace(/:root\{[^}]*\}/g,m=>' '.repeat(m.length)):css;
    // Official print documents (attendance book, register, receipts) follow print rules, not screen tokens.
    const printFree=body.replace(/\/\* design-lint: print-document \*\/[\s\S]*?\/\* design-lint: end \*\//g,m=>m.replace(/[^\n]/g,' '));
    const clean=printFree.replace(/\/\*[\s\S]*?\*\//g,m=>' '.repeat(m.length));
    for(const block of clean.matchAll(/\{([^{}]*)\}/g)){
      let at=block.index+1;
      for(const decl of block[1].split(';')){
        const m=decl.match(/^\s*([a-z-]+)\s*:\s*([\s\S]+?)\s*$/);const where=`${file}:${lineOf(text,offset+at)}`;at+=decl.length+1;
        if(!m)continue;
        // Pages may define their own layout variables, but never colors (colors are shared tokens only).
        if(m[1].startsWith('--')){if(file!==TOKENS&&/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i.test(m[2]))errors.push(`${where} ${m[1]}: 화면에서 색 변수를 새로 만들지 않습니다`);continue;}
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
for(const file of [TOKENS,SHARED,...PAGES])check(file);
// Cache busting (docs/DESIGN.md 2-6): GitHub Pages lets browsers keep these files for 10 minutes, so every reference
// carries ?v=<first 8 hex of the file's SHA-256>. A changed file gets a new address and is fetched at once.
// `node tests/design-lint.cjs --fix` rewrites the versions; without --fix a stale or missing version is an error.
// Order matters: hada-ui.css imports hada-tokens.css, so its own version is computed after its import is updated.
const crypto=require('crypto');
const FIX=process.argv.includes('--fix');
const VERSIONED=[['assets/hada-tokens.css',['assets/hada-ui.css']],['assets/hada-ui.css',PAGES],['assets/hada-shortcuts.js',PAGES],['admin_auth.js',PAGES],['admin_settings.js',PAGES],['class_room.js',PAGES],
  // 학부모 리포트는 공용 스타일 대상(PAGES)이 아니지만 스크립트는 같은 방식으로 버전을 붙여, 고친 내용이 휴대폰에 바로 내려가게 한다.
  ['student_report_part1.js',['student_report.html']],['student_report_part2.js',['student_report.html']]];
const version=file=>crypto.createHash('sha256').update(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n')).digest('hex').slice(0,8);
for(const [asset,users] of VERSIONED){
  const v=version(asset);
  for(const user of users){
    const ref=user===SHARED?asset.replace('assets/',''):asset;
    const pattern=new RegExp(`((?:href|src)="|url\\(")${ref.replace(/[.]/g,'\\.')}(\\?v=[0-9a-f]*)?"`,'g');
    let text=fs.readFileSync(user,'utf8');
    if(!pattern.test(text))continue;
    const fixed=text.replace(pattern,(_,pre)=>`${pre}${ref}?v=${v}"`);
    if(fixed===text)continue;
    if(FIX){fs.writeFileSync(user,fixed);console.log(`버전 갱신: ${user} → ${ref}?v=${v}`);}
    else errors.push(`${user}: ${ref}의 버전 표시가 파일 내용과 다릅니다(?v=${v}). node tests/design-lint.cjs --fix 로 고칩니다`);
  }
}
for(const page of PAGES){
  const html=fs.readFileSync(page,'utf8');
  if(!/href="assets\/hada-ui\.css(\?v=[0-9a-f]{8})?"/.test(html))errors.push(`${page}: assets/hada-ui.css를 불러오지 않습니다`);
  // Scripts may build document tables with computed widths; only the static markup is checked.
  if(/\sstyle="/.test(html.replace(/<script[\s\S]*?<\/script>/g,'')))errors.push(`${page}: 인라인 style 속성 대신 클래스를 씁니다`);
}
if(errors.length){console.error(errors.join('\n'));console.error(`디자인 규칙 위반 ${errors.length}건`);process.exit(1);}
console.log(`디자인 규칙 검사 통과: ${[SHARED,...PAGES].join(', ')}`);
