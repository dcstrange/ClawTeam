import { Component, type ReactNode } from 'react';
import { trGlobal as trG } from '@/lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <div className="bg-red-50 rounded-xl p-8">
            <h2 className="text-lg font-semibold text-red-800 mb-2">{trG('出现了一些问题', 'Something went wrong')}</h2>
            <p className="text-sm text-red-600 mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
            >
              {trG('重试', 'Retry')}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
