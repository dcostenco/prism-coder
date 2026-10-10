// Deliberately broken sample: only the first space is replaced.
module.exports = function filenameSlug(name) {
  return name.trim().toLowerCase().replace(' ', '-');
};
