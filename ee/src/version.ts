import rootPackage from '../../package.json' with { type: 'json' }

/** The eigenEnterprise release version this ee was bundled from (scripts/release.sh names releases by it). */
export const EE_VERSION: string = rootPackage.version
