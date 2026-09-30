import type { ElectionPreset } from './ballot';

/** A JSON value. */
export type AnyJson = boolean | number | string | null | JsonArray | JsonMap;
/** A JSON object. */
export interface JsonMap {
  [key: string]: AnyJson;
}
/** A JSON array. */
export type JsonArray = AnyJson[];

/** Free-form data a client keeps next to a question, a choice or the election. */
export type CustomMeta = AnyJson;

/**
 * Text in several languages: `default`, then one entry per language code.
 * When there are translations, the default text is repeated under its own
 * code, as in `{ default: 'Yes', en: 'Yes', es: 'Sí' }`.
 */
export type MultiLanguage<T> = {
  default: T;
  [lang: string]: T;
};

/** Plain text (the `default` language only) or text in several languages. */
export type LocalizedText = string | MultiLanguage<string>;

/** A choice of a question; `value` is the ballot field it fills. */
export interface IChoice {
  title: MultiLanguage<string>;
  value: number;
  meta?: CustomMeta;
  results?: string;
  answer?: number;
}

export type Choice = Pick<IChoice, 'title' | 'value' | 'meta'>;

/** A question of the election. */
export interface IQuestion {
  title: MultiLanguage<string>;
  description?: MultiLanguage<string>;
  numAbstains?: string;
  meta?: CustomMeta;
  choices: Array<IChoice>;
}

export type Question = Pick<IQuestion, 'title' | 'description' | 'choices' | 'meta'>;

/** Metadata document version: the SDK writes `1.1`. */
export type ProtocolVersion = '1.1' | '1.2';

/**
 * The election metadata document served at a process's `metadataURI`, whose
 * SHA-256 the registry stores as `metadataHash`. Its keys are written in the
 * order of this interface; see `serializeMetadata`.
 *
 * The {@link ElectionPreset} a process was created with, if any, is kept in
 * `meta.electionPreset`, which explorers read as the kind of ballot.
 */
export interface ElectionMetadata {
  version: ProtocolVersion;
  title: MultiLanguage<string>;
  description: MultiLanguage<string>;
  media?: {
    header?: string;
    logo?: string;
  };
  questions: Array<IQuestion>;
  meta?: {
    electionPreset?: ElectionPreset;
    [key: string]: unknown;
  };
}

/** A choice to build a metadata document from. */
export interface ChoiceConfig {
  title: LocalizedText;
  /** The ballot field this choice fills, from 0. */
  value: number;
  meta?: CustomMeta;
}

/** A question to build a metadata document from. */
export interface QuestionConfig {
  title: LocalizedText;
  description?: LocalizedText;
  choices: ReadonlyArray<ChoiceConfig>;
  meta?: CustomMeta;
}

/** What `buildElectionMetadata` turns into a metadata document. */
export interface ElectionMetadataConfig {
  title: LocalizedText;
  description?: LocalizedText;
  questions: ReadonlyArray<QuestionConfig>;
  /** Stored as `meta.electionPreset`. */
  electionPreset?: ElectionPreset;
  media?: { header?: string; logo?: string };
  /** Other `meta` entries. */
  meta?: JsonMap;
}

// An empty yes/no document, as `buildElectionMetadata` writes one.
export const ElectionMetadataTemplate: ElectionMetadata = {
  version: '1.1',
  title: {
    default: '',
  },
  description: {
    default: '',
  },
  questions: [
    {
      title: {
        default: '',
      },
      description: {
        default: '',
      },
      choices: [
        {
          title: {
            default: 'Yes',
          },
          value: 0,
        },
        {
          title: {
            default: 'No',
          },
          value: 1,
        },
      ],
    },
  ],
};

/** A fresh copy of {@link ElectionMetadataTemplate}. */
export const getElectionMetadataTemplate = (): ElectionMetadata => {
  return JSON.parse(JSON.stringify(ElectionMetadataTemplate)) as ElectionMetadata;
};
