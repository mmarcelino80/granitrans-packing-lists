// Glossary for generic material and handling descriptions. Commercial names,
// references and customer codes are kept in the language of the guide.
const entries = [
  ['cavalete de ferro', 'caballete de hierro', 'chevalet en fer'],
  ['cavaletes de ferro', 'caballetes de hierro', 'chevalets en fer'],
  ['de aço inoxidável', 'de acero inoxidable', 'en acier inoxydable'],
  ['de aço galvanizado', 'de acero galvanizado', 'en acier galvanisé'],
  ['de ferro', 'de hierro', 'en fer'],
  ['de aço', 'de acero', 'en acier'],
  ['de madeira', 'de madera', 'en bois'],
  ['de plástico', 'de plástico', 'en plastique'],
  ['de metal', 'de metal', 'en métal'],
  ['em ferro', 'de hierro', 'en fer'],
  ['em aço', 'de acero', 'en acier'],
  ['em madeira', 'de madera', 'en bois'],
  ['em aço inox', 'de acero inoxidable', 'en acier inoxydable'],
  ['de aço inox', 'de acero inoxidable', 'en acier inoxydable'],
  ['em alumínio', 'de aluminio', 'en aluminium'],
  ['de alumínio', 'de aluminio', 'en aluminium'],
  ['ferro', 'hierro', 'fer'],
  ['aço', 'acero', 'acier'],
  ['madeira', 'madera', 'bois'],
  ['plástico', 'plástico', 'plastique'],
  ['cavalete', 'caballete', 'chevalet'],
  ['cavaletes', 'caballetes', 'chevalets'],
  ['palete', 'palé', 'palette'],
  ['paletes', 'palés', 'palettes'],
  ['chapa', 'tabla', 'tranche'],
  ['chapas', 'tablas', 'tranches'],
  ['placa', 'placa', 'plaque'],
  ['placas', 'placas', 'plaques'],
  ['ladrilho', 'baldosa', 'carreau'],
  ['ladrilhos', 'baldosas', 'carreaux'],
  ['amostra', 'muestra', 'échantillon'],
  ['amostras', 'muestras', 'échantillons'],
  ['cerâmica', 'cerámica', 'céramique'],
  ['granito', 'granito', 'granit'],
  ['mármore', 'mármol', 'marbre'],
  ['quartzo', 'cuarzo', 'quartz'],
  ['quartzito', 'cuarcita', 'quartzite'],
  ['caixa', 'caja', 'caisse'],
  ['caixas', 'cajas', 'caisses'],
  ['bancada', 'encimera', 'plan de travail'],
  ['bancadas', 'encimeras', 'plans de travail'],
  ['peça', 'pieza', 'pièce'],
  ['peças', 'piezas', 'pièces'],
  ['peça de substituição', 'pieza de recambio', 'pièce de rechange'],
  ['peças de substituição', 'piezas de recambio', 'pièces de rechange'],
  ['proteção de cantos', 'protección de esquinas', 'protection des angles'],
  ['cantoneira', 'cantonera', 'cornière'],
  ['cantoneiras', 'cantoneras', 'cornières'],
  ['calço', 'calzo', 'cale'],
  ['calços', 'calzos', 'cales'],
  ['cinta', 'cincha', 'sangle'],
  ['cintas', 'cinchas', 'sangles'],
  ['suporte', 'soporte', 'support'],
  ['suportes', 'soportes', 'supports'],
  ['equipamento', 'equipo', 'équipement'],
  ['equipamentos', 'equipos', 'équipements'],
  ['estrutura metálica', 'estructura metálica', 'structure métallique'],
  ['estruturas metálicas', 'estructuras metálicas', 'structures métalliques'],
  ['gancho', 'gancho', 'crochet'],
  ['ganchos', 'ganchos', 'crochets'],
  ['saco', 'saco', 'sac'],
  ['sacos', 'sacos', 'sacs'],
  ['separador', 'separador', 'séparateur'],
  ['separadores', 'separadores', 'séparateurs'],
  ['embalagem', 'embalaje', 'emballage'],
  ['embalagens', 'embalajes', 'emballages'],
  ['acabamento', 'acabado', 'finition'],
  ['acabamentos', 'acabados', 'finitions'],
  ['mate', 'mate', 'mat'],
  ['mates', 'mates', 'mats'],
  ['couro', 'cuero', 'cuir'],
  ['em bruto', 'en bruto', 'à l’état brut'],
  ['sem acabamento', 'sin acabado', 'sans finition'],
  ['stock', 'stock', 'stock'],
  ['encomenda', 'pedido', 'commande'],
  ['encomendas', 'pedidos', 'commandes'],
  ['escovar', 'cepillar', 'brosser'],
  ['polir', 'pulir', 'polir'],
  ['encosto', 'copete', 'crédence'],
  ['encostos', 'copetes', 'crédences'],
  ['devolução', 'devolución', 'retour'],
  ['entrega', 'entrega', 'livraison'],
  ['expedição', 'expedición', 'expédition'],
  ['transporte', 'transporte', 'transport'],
  ['referência', 'referencia', 'référence'],
  ['cliente', 'cliente', 'client'],
  ['observação', 'observación', 'observation'],
  ['observações', 'observaciones', 'observations'],
  ['descarregar', 'descargar', 'décharger'],
  ['carregar', 'cargar', 'charger'],
  ['carga e descarga', 'carga y descarga', 'chargement et déchargement'],
  ['local de carga', 'lugar de carga', 'lieu de chargement'],
  ['local de descarga', 'lugar de descarga', 'lieu de déchargement'],
  ['não empilhar', 'no apilar', 'ne pas empiler'],
  ['manter na vertical', 'mantener en posición vertical', 'maintenir à la verticale'],
  ['manter em posição vertical', 'mantener en posición vertical', 'maintenir à la verticale'],
  ['manter seco', 'mantener seco', 'garder au sec'],
  ['manusear com cuidado', 'manipular con cuidado', 'manipuler avec précaution'],
  ['entrega urgente', 'entrega urgente', 'livraison urgente'],
  ['cortar à medida', 'cortar a medida', 'couper sur mesure'],
  ['verificar a carga', 'verificar la carga', 'vérifier le chargement'],
  ['fixar a carga', 'fijar la carga', 'arrimer le chargement'],
  ['embalar', 'embalar', 'emballer'],
  ['paletizar', 'paletizar', 'palettiser'],
  ['frágil', 'frágil', 'fragile'],
  ['frágeis', 'frágiles', 'fragiles'],
  ['destino final', 'destino final', 'destination finale'],
  ['sem danos', 'sin daños', 'sans dommages'],
  ['metros quadrados', 'metros cuadrados', 'mètres carrés'],
  ['metro quadrado', 'metro cuadrado', 'mètre carré'],
  ['metros lineares', 'metros lineales', 'mètres linéaires'],
  ['metro linear', 'metro lineal', 'mètre linéaire'],
];

const finishStems = [
  ['polid', 'pulid', 'poli'],
  ['acetinad', 'satinad', 'satiné'],
  ['escovad', 'cepillad', 'brossé'],
  ['flamejad', 'flamead', 'flammé'],
  ['bujardad', 'abujardad', 'bouchardé'],
  ['amaciad', 'apomazad', 'adouci'],
  ['levigad', 'apomazad', 'adouci'],
  ['envelhecid', 'envejecid', 'vieilli'],
  ['brut', 'brut', 'brut'],
  ['galvanizad', 'galvanizad', 'galvanisé'],
  ['pintad', 'pintad', 'peint'],
  ['tratad', 'tratad', 'traité'],
];
for (const [pt, es, fr] of finishStems) {
  for (const [ending, frenchEnding] of [['o', ''], ['a', 'e'], ['os', 's'], ['as', 'es']]) {
    entries.push([pt + ending, es + ending, fr + frenchEnding]);
  }
}

const units = [
  ['Chapa', 'Chapas', 'tabla', 'tablas', 'tranche', 'tranches', 'ch'],
  ['Palete', 'Paletes', 'palé', 'palés', 'palette', 'palettes'],
  ['cavalete', 'cavaletes', 'caballete', 'caballetes', 'chevalet', 'chevalets'],
  ['placa', 'placas', 'placa', 'placas', 'plaque', 'plaques'],
  ['Ladrilho', 'Ladrilhos', 'baldosa', 'baldosas', 'carreau', 'carreaux'],
  ['caixa', 'caixas', 'caja', 'cajas', 'caisse', 'caisses'],
  ['peça', 'peças', 'pieza', 'piezas', 'pièce', 'pièces'],
  ['unidade', 'unidades', 'unidad', 'unidades', 'unité', 'unités', 'un', 'und', 'ud'],
  ['m²', 'm²', 'm²', 'm²', 'm²', 'm²', 'm2', 'metro quadrado', 'metros quadrados'],
  ['m³', 'm³', 'm³', 'm³', 'm³', 'm³', 'm3', 'metro cúbico', 'metros cúbicos'],
  ['m', 'm', 'm', 'm', 'm', 'm', 'ml', 'metro linear', 'metros lineares'],
  ['kg', 'kg', 'kg', 'kg', 'kg', 'kg', 'quilograma', 'quilogramas'],
];

const sourceUnit = new Map(units.flatMap((forms) => [forms[0], forms[1], ...forms.slice(6)]
  .map((value) => [value.toLowerCase(), forms])));
const terms = new Map(entries.map(([pt, ...labels]) => [pt, labels]));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const boundary = (pattern) => `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
const termPattern = boundary(entries.map(([pt]) => pt).sort((a, b) => b.length - a.length).map(escapeRegex).join('|'));

export function canonicalLogisticsUnit(unit) {
  return sourceUnit.get(unit.toLowerCase())?.[0] ?? unit;
}

export function translateLogisticsUnit(unit, count, language) {
  const forms = sourceUnit.get(unit.toLowerCase());
  if (!forms) return unit;
  const singular = count === '?' ? unit.toLowerCase() === forms[0].toLowerCase()
    : Number(count.replace(',', '.')) === 1;
  const offset = language === 'es' ? 2 : language === 'pt-fr' ? 4 : 0;
  return forms[offset + (singular ? 0 : 1)];
}

function preserveCase(source, translation) {
  if (source === source.toUpperCase()) return translation.toUpperCase();
  const first = source[0];
  if (first !== first.toLowerCase()) return translation[0].toUpperCase() + translation.slice(1);
  return translation;
}

export function translateLogisticsText(value, language, row) {
  if (!value || language === 'pt' || value === '[Descrição por confirmar]') return value;
  const identities = [row.commercialName, row.reference, row.client].filter((term) => term?.trim())
    .map((term) => term.trim().replace(/\s+/gu, ' '))
    .sort((a, b) => b.length - a.length).map(escapeRegex);
  // Quoted names and compound product codes can also occur inside descriptions
  // and observations, alongside the separate identity fields in the guide.
  const protectedPattern = [
    ...identities.map(boundary),
    '"[^"\\n]+"|«[^»\\n]+»',
    boundary('[\\p{L}\\p{N}]+(?:[-/_][\\p{L}\\p{N}]+)+'),
  ].join('|');
  const pattern = new RegExp(`(${protectedPattern})|(${termPattern})`, 'giu');
  return value.replace(pattern, (match, protectedValue, term) => {
    if (protectedValue) return match;
    const translation = terms.get(term.toLowerCase())?.[language === 'es' ? 0 : 1];
    return translation ? preserveCase(term, translation) : match;
  });
}
