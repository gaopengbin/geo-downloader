# React 19 / Radix ref stability regression

The reported production crash is React #185. Its `dispatchSetState → setRef → Array.map → setRef` stack matches the unstable composed-ref bug fixed upstream in [Slot #3899](https://github.com/radix-ui/primitives/pull/3899) and the [related primitives #3967](https://github.com/radix-ui/primitives/pull/3967).

The fixture imports GeoD's actual shared components. It uses synthetic source/date catalogues, never native downloads, account data or credentials. It is a separate entry and is not imported by the desktop application's production entry.

## Run

From `frontend`, start the ordinary Vite development server, then open `/tests/ref-stability.html` with the available browser tooling. For a minified production check, run:

```text
node tests/build-ref-stability.mjs <new-absent-output-directory>
```

Serve that output directory over loopback HTTP and open `tests/ref-stability.html`. The helper refuses to overwrite an existing directory.

## Cases

- Click each ref check. A stable DOM attachment may notify its owner and trigger an update; it must not reattach continuously or throw. The original dependencies failed both checks, including React #185 in the production build. Fixed production output reports one attachment update per mounted case.
- Run 120 catalogue switches while closed, then 120 refreshes with the date list open. Wait for `completed: 120` and `running: false`, close the list, and confirm no `case-error` element exists.
- Select the historical provider and a date manually; reload its catalogue without changing the selected date.
- Open and close the shared dialog/popover and select the dropdown item. Check the browser console for errors.

Use the production build for the final comparison. Development Strict Mode can attach a ref more than once as an intentional check, so production attachment counts must not be used as development assertions.

## Dependency scope

The fix pins Select, Dialog, Popover, Dropdown Menu and Slot to verified published versions. The `react-slot` npm override is intentional: older Radix packages otherwise nest their exact old Slot dependency even when the top-level package is updated. Inspect the installed tree with `npm ls @radix-ui/react-slot --all` after a clean install; there should be no legacy Slot copies.

This browser regression is separate from the existing `npm test` suite and from native imagery/download acceptance.
