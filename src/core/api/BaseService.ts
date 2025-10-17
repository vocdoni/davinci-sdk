import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';

export interface ApiError {
  error: string;
  code: number;
}

export class BaseService {
  protected axios: AxiosInstance;

  constructor(baseURL: string, config?: AxiosRequestConfig) {
    this.axios = axios.create({ baseURL, ...config });
  }

  protected async request<T>(config: AxiosRequestConfig): Promise<T> {
    try {
      const response = await this.axios.request<T>(config);
      return response.data;
    } catch (err) {
      const error = err as AxiosError<ApiError>;
      const message = error.response?.data?.error || error.message;
      const code = error.response?.data?.code || error.code || error.response?.status || 500;
      const e = new Error(message);
      (e as any).code = code;
      throw e;
    }
  }
}
