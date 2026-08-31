declare module 'shpjs' {
  import type {
    FeatureCollection,
    GeoJsonObject,
    Geometry,
  } from 'geojson'

  type ShpInput = ArrayBuffer | ArrayBufferView | string | Blob
  type ShpBundleInput = {
    shp: ArrayBuffer | ArrayBufferView
    dbf?: ArrayBuffer | ArrayBufferView
    prj?: ArrayBuffer | ArrayBufferView | string
    cpg?: ArrayBuffer | ArrayBufferView | string
  }

  function shp(
    input: ShpInput | ShpBundleInput,
  ): Promise<FeatureCollection | FeatureCollection[] | GeoJsonObject>

  export default shp

  export function parseShp(
    buffer: ArrayBuffer | ArrayBufferView,
    prj?: string | unknown,
  ): Geometry[]

  export function parseDbf(
    buffer: ArrayBuffer | ArrayBufferView,
    cpg?: string,
  ): Record<string, unknown>[]

  export function combine(
    args: [Geometry[], Record<string, unknown>[] | null | undefined],
  ): FeatureCollection

  export function parseZip(
    buffer: ArrayBuffer | ArrayBufferView,
    whiteList?: string[],
  ): Promise<FeatureCollection | FeatureCollection[]>
}
