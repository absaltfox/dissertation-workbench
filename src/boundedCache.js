/**
 * Small LRU cache with the subset of the Map interface the metrics routes use.
 * Bounds memory when cache keys derive from user-controlled request params.
 */
export function createBoundedCache(maxEntries = 300) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) {
        map.delete(map.keys().next().value);
      }
    },
    has(key) {
      return map.has(key);
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
