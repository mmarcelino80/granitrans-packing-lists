const GUIDE_TYPES = {
  jpg: ['image/jpeg', 'image/jpg'],
  jpeg: ['image/jpeg', 'image/jpg'],
  png: ['image/png'],
  pdf: ['application/pdf'],
};

export function collectGuides(files) {
  const accepted = [];
  const errors = [];

  for (const file of files) {
    const extension = /\.([a-z]+)$/i.exec(file.name)?.[1].toLowerCase();
    const types = Object.hasOwn(GUIDE_TYPES, extension) ? GUIDE_TYPES[extension] : [];
    const hasKnownType = file.type && file.type !== 'application/octet-stream';
    if (!types.length || (hasKnownType && !types.includes(file.type))) {
      errors.push(`${file.name}: escolha um ficheiro JPG, PNG ou PDF.`);
    } else if (file.size === 0) {
      errors.push(`${file.name}: o ficheiro está vazio.`);
    } else {
      accepted.push(file);
    }
  }
  return { accepted, errors };
}
