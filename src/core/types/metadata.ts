import type { ElectionPreset } from './ballot';

// Basic JSON types
export type AnyJson = boolean | number | string | null | JsonArray | JsonMap | any;
export interface JsonMap {
  [key: string]: AnyJson;
}
export interface JsonArray extends Array<AnyJson> {}

// Custom metadata type
export type CustomMeta = AnyJson | JsonArray | JsonMap;

// Multi-language support
export type MultiLanguage<T> = {
  default: T;
  [lang: string]: T;
};

// Election choice types
export interface IChoice {
  title: MultiLanguage<string>;
  value: number;
  meta?: CustomMeta;
  results?: string;
  answer?: number;
}

export type Choice = Pick<IChoice, 'title' | 'value' | 'meta'>;

// Election question types
export interface IQuestion {
  title: MultiLanguage<string>;
  description?: MultiLanguage<string>;
  numAbstains?: string;
  meta?: CustomMeta;
  choices: Array<IChoice>;
}

export type Question = Pick<IQuestion, 'title' | 'description' | 'choices' | 'meta'>;

// Protocol version type
export type ProtocolVersion = '1.1' | '1.2';

/**
 * Off-chain election metadata stored at `metadataURI`.
 *
 * The optional `type` field records the {@link ElectionPreset} used to
 * create the process (when one was used). Processes created with a raw
 * `BallotMode` carry no `type` value. Direct consumers of metadata
 * produced by older SDK versions may see legacy enum-shaped values in
 * `type`; readers should treat anything that doesn't match the current
 * `ElectionPreset` shape as "no preset" (see
 * `parseElectionPresetFromMetadata` in `./ballot.ts`).
 */
export interface ElectionMetadata {
  version: ProtocolVersion;
  title: MultiLanguage<string>;
  description: MultiLanguage<string>;
  media: {
    header: string;
    logo: string;
  };
  meta?: {
    [key: string]: unknown;
  };
  questions: Array<IQuestion>;
  type?: ElectionPreset;
}

// Template for creating new election metadata. The `type` field is
// intentionally omitted — it is populated by the SDK when the caller
// passes an `electionPreset` during process creation.
export const ElectionMetadataTemplate: ElectionMetadata = {
  version: '1.2',
  title: {
    default: '',
  },
  description: {
    default: '',
  },
  media: {
    header: '',
    logo: '',
  },
  meta: {},
  questions: [
    {
      title: {
        default: '',
      },
      description: {
        default: '',
      },
      meta: {},
      choices: [
        {
          title: {
            default: 'Yes',
          },
          value: 0,
          meta: {},
        },
        {
          title: {
            default: 'No',
          },
          value: 1,
          meta: {},
        },
      ],
    },
  ],
};

// Helper function to create a new metadata template
export const getElectionMetadataTemplate = (): ElectionMetadata => {
  return JSON.parse(JSON.stringify(ElectionMetadataTemplate));
};
