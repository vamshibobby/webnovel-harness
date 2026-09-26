/** Minimal typings for the vendored d3-delaunay bundle — only what the spike uses. */
export class Delaunay {
  static from(points: ArrayLike<[number, number]>): Delaunay;
  voronoi(bounds: [number, number, number, number]): Voronoi;
  neighbors(i: number): Iterable<number>;
}
export class Voronoi {
  cellPolygon(i: number): Array<[number, number]> | null;
}
