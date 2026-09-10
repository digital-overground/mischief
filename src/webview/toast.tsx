export const Toast = ({ message }: { message: string }): React.JSX.Element => (
  <div className="toast" role="status">
    {message}
  </div>
);
